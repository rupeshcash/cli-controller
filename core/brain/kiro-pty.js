// core/brain/kiro-pty.js — drive Kiro INTERACTIVELY in a real PTY (node-pty).
// Why: `kiro-cli --no-interactive --resume-id` doesn't rehydrate TUI/subagent sessions
// (Kiro bug kirodotdev/Kiro#9066); the interactive TUI does. We give Kiro a real PTY, wait
// for the input box, send the prompt, watch the stream for turn completion, and scrape the
// assistant's answer from the TUI output (the interactive TUI does NOT persist to cli/*.jsonl,
// so we can't read it back from disk). node-pty is an OPTIONAL native dep: if absent,
// ptySupported() is false and callers fall back to headless. POC — resume only.
let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const BIN = () => process.env.KIRO_BIN || 'kiro-cli';
const READY = /ask a question or describe a task/i;      // TUI input box is ready
const ENDMARK = /Credits:.*Time:\s*\d|Time:\s*\d+\s*s/i;  // end-of-turn status line

function ptySupported() { return !!pty; }

// Strip ANSI + TUI chrome, dedupe redraw lines → the assistant's prose answer.
function cleanTui(s, prompt) {
  const noAnsi = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
  const drop = /Thinking\.\.\.|◕|·\s*claude-|^main\s+·|^─{5,}|Kiro is working|Type to steer|Ctrl\+|▸\s*Credits|Time:\s*\d|ask a question or describe|\/copy to clipboard|esc to cancel|hooks finished|of\s+\d+\s+hooks|Initializing|type to queue|Thought for\s|\(ENG-|^~\/|·\s*\(/i;
  const seen = new Set(); const out = [];
  for (let line of noAnsi.replace(/\r/g, '\n').split('\n')) {
    const t = line.replace(/^[\s●╰│>·]+/, '').trim(); // strip TUI glyph prefixes
    if (!t || drop.test(t)) continue;
    if (prompt && t === prompt.trim()) continue; // drop the echoed prompt
    if (seen.has(t)) continue;                    // the TUI redraws lines repeatedly
    seen.add(t); out.push(t);
  }
  return out.join('\n').trim();
}

// Read Kiro's own /transcript --json export → the last model (assistant) message = the clean answer.
function readLastModel(txPath) {
  try {
    const arr = JSON.parse(fs.readFileSync(txPath, 'utf8'));
    const models = arr.filter((e) => e && e.role === 'model' && e.content);
    return models.length ? String(models[models.length - 1].content).trim() : '';
  } catch { return ''; }
}

// Run one interactive turn in a PTY. Resolves { ok, output, error, sessionId }. Never rejects.
function runKiroPty({ cwd, sessionId, agent, model, trustTools, prompt, timeoutMs = 0, onSpawn, onData }) {
  return new Promise((resolve) => {
    if (!pty) return resolve({ ok: false, output: '', error: 'node-pty not installed', sessionId });
    if (!sessionId) return resolve({ ok: false, output: '', error: 'pty-resume-only', sessionId });
    const kargs = ['chat', '--resume-id', sessionId];
    if (agent) kargs.push('--agent', agent);
    if (model) kargs.push('--model', model);
    kargs.push(`--trust-tools=${trustTools || ''}`);

    let child;
    try { child = pty.spawn(process.env.KIRO_BIN_PATH || BIN(), kargs, { name: 'xterm-color', cols: 120, rows: 40, cwd: cwd || process.cwd(), env: process.env }); }
    catch (e) { return resolve({ ok: false, output: '', error: `PTY spawn failed: ${e.message}`, sessionId }); }
    if (typeof onSpawn === 'function') onSpawn(child);

    const txPath = path.join(os.tmpdir(), `kiro-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    let all = '', answerFrom = 0, sent = false, settled = false, quiet = null, readyTimer = null, reset = false, txSent = false;
    const sendPrompt = () => {
      if (sent) return; sent = true; clearTimeout(readyTimer);
      answerFrom = all.length;
      try { child.write((prompt || '') + '\r'); } catch {}
    };
    // Turn done → have Kiro export its own clean transcript, then finish once the file lands.
    const exportTranscript = () => {
      if (txSent) return; txSent = true;
      try { child.write(`/transcript save --json ${txPath}\r`); } catch {}
      let tries = 0;
      const wait = setInterval(() => { if (fs.existsSync(txPath) || ++tries > 20) { clearInterval(wait); finish(); } }, 300);
    };
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(quiet); clearTimeout(readyTimer); clearTimeout(hard);
      try { child.kill(); } catch {}
      let ans = readLastModel(txPath);                          // clean answer from Kiro's own export
      if (!ans) ans = cleanTui(all.slice(answerFrom), prompt);  // fallback: scrape the TUI stream
      try { fs.unlinkSync(txPath); } catch {}
      resolve({ ok: !!ans, output: ans || '(interactive turn completed but no answer was captured)', error: ans ? '' : 'no-answer', sessionId });
    };
    child.onData((d) => {
      all += d;
      if (typeof onData === 'function') { try { onData(d); } catch {} }
      if (!sent) { if (READY.test(all)) { clearTimeout(readyTimer); readyTimer = setTimeout(sendPrompt, 800); } return; } // wait for the box, then a beat
      if (!reset && /Thinking\.\.\.|Thought for/.test(d)) { reset = true; answerFrom = all.length; }
      if (!txSent && ENDMARK.test(d)) { clearTimeout(quiet); quiet = setTimeout(exportTranscript, 2500); } // end-of-turn → export
    });
    // Fallback: if the ready box never matched, send after 8s anyway.
    readyTimer = setTimeout(sendPrompt, 8000);
    const hard = setTimeout(finish, timeoutMs > 0 ? timeoutMs : 20 * 60 * 1000);
    child.onExit(() => finish());
  });
}

// Best-effort: delete throwaway session(s) created in a scratch cwd, then remove the dir.
function cleanupScratch(scratch) {
  try {
    const r = spawnSync(BIN(), ['chat', '--list-sessions', '-f', 'json'], { cwd: scratch, encoding: 'utf8', timeout: 6000 });
    const arr = JSON.parse(r.stdout || '[]');
    const entry = arr.find((e) => e.cwd === scratch) || arr[0];
    for (const s of (entry && entry.sessions) || []) if (s.sessionId) spawnSync(BIN(), ['chat', '--delete-session', s.sessionId], { timeout: 6000 });
  } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

// Second pass: a fast, throwaway headless Kiro (Sonnet, no tools, fresh scratch session that we
// delete after) extracts the agent's final answer from the raw PTY scrape and returns clean
// Markdown — robust where regex isn't. Never throws; returns '' on any failure so callers fall back.
function headlessFormat(raw, userPrompt, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!raw) return resolve('');
    let scratch;
    try { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-fmt-')); } catch { return resolve(''); }
    const prompt = [
      'You are a formatter, not an assistant. After ===RAW=== is the raw terminal output of a coding agent answering a user.',
      `The user asked: "${(userPrompt || '').slice(0, 500)}".`,
      "Return ONLY the agent's final answer to that request, as clean GitHub-flavored Markdown.",
      'Strip: tool calls, shell commands and their output, step-by-step planning/narration, spinners/UI chrome, and any repeated earlier conversation. Keep real content (prose, code blocks, tables, lists, links). No preamble or commentary — output only the answer.',
      '', '===RAW===', raw,
    ].join('\n');
    const args = ['chat', '--no-interactive', '--trust-tools=', '--model', process.env.KIRO_FORMAT_MODEL || 'claude-sonnet-4.6'];
    let child;
    try { child = spawn(BIN(), args, { cwd: scratch, env: process.env }); }
    catch { cleanupScratch(scratch); return resolve(''); }
    let out = '';
    try { child.stdin.on('error', () => {}); child.stdin.write(prompt); child.stdin.end(); } catch {}
    child.stdout.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); cleanupScratch(scratch); resolve(''); });
    child.on('close', () => {
      clearTimeout(timer); cleanupScratch(scratch);
      resolve(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').replace(/^>\s?/, '').trim());
    });
  });
}

module.exports = { runKiroPty, ptySupported, cleanTui, headlessFormat };
