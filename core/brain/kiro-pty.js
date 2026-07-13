// core/brain/kiro-pty.js — drive Kiro INTERACTIVELY in a real PTY (node-pty).
// Why: `kiro-cli --no-interactive --resume-id` doesn't rehydrate TUI/subagent sessions
// (Kiro bug kirodotdev/Kiro#9066); the interactive TUI does. We give Kiro a real PTY, wait
// for the input box, send the prompt, watch the stream for turn completion, and scrape the
// assistant's answer from the TUI output (the interactive TUI does NOT persist to cli/*.jsonl,
// so we can't read it back from disk). node-pty is an OPTIONAL native dep: if absent,
// ptySupported() is false and callers fall back to headless. POC — resume only.
let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

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

    let all = '', answerFrom = 0, sent = false, settled = false, quiet = null, readyTimer = null, reset = false;
    const sendPrompt = () => {
      if (sent) return; sent = true; clearTimeout(readyTimer);
      answerFrom = all.length;
      try { child.write((prompt || '') + '\r'); } catch {}
    };
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(quiet); clearTimeout(readyTimer); clearTimeout(hard);
      try { child.kill(); } catch {}
      const ans = cleanTui(all.slice(answerFrom), prompt);
      resolve({ ok: !!ans, output: ans || '(interactive turn completed but no answer text was captured)', error: ans ? '' : 'no-answer', sessionId });
    };
    child.onData((d) => {
      all += d;
      if (typeof onData === 'function') { try { onData(d); } catch {} }
      if (!sent) { if (READY.test(all)) { clearTimeout(readyTimer); readyTimer = setTimeout(sendPrompt, 800); } return; } // wait for the box, then a beat
      // The TUI re-renders the prior conversation after send; skip it — the NEW answer begins
      // once Kiro starts thinking. Reset the answer window to that point (once).
      if (!reset && /Thinking\.\.\.|Thought for/.test(d)) { reset = true; answerFrom = all.length; }
      if (ENDMARK.test(d)) { clearTimeout(quiet); quiet = setTimeout(finish, 2500); } // end-of-turn, then settle
    });
    // Fallback: if the ready box never matched, send after 8s anyway.
    readyTimer = setTimeout(sendPrompt, 8000);
    const hard = setTimeout(finish, timeoutMs > 0 ? timeoutMs : 20 * 60 * 1000);
    child.onExit(() => finish());
  });
}

module.exports = { runKiroPty, ptySupported, cleanTui };
