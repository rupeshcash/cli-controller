// src/kiro.js — thin wrapper around `kiro-cli chat` in headless mode.
// Uses spawn with an args array (never a shell string) to avoid command injection.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');

const BIN = () => process.env.KIRO_BIN || 'kiro-cli';

// Strip ANSI escape sequences + carriage-return spinner noise that kiro-cli emits
// even in --no-interactive mode, so Slack shows clean text.
const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function clean(s) {
  return (s || '')
    .replace(ANSI, '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildArgs({ sessionId, agent, model, trustTools }) {
  const args = ['chat', '--no-interactive'];
  if (sessionId) args.push('--resume-id', sessionId);
  if (agent) args.push('--agent', agent);
  if (model) args.push('--model', model);

  // Headless mode can't answer permission prompts, so ALWAYS pass an explicit
  // trust set. 'ALL' => full autonomy (dangerous on a work box); otherwise a
  // comma list like 'fs_read' (read-only, safe) or '' (no tools).
  if ((trustTools || '').toUpperCase() === 'ALL') {
    args.push('--trust-all-tools');
  } else {
    args.push(`--trust-tools=${trustTools || ''}`);
  }
  // Prompt is delivered via stdin (see runKiro) — robust for large/multiline text.
  return args;
}

// Run one headless turn. Resolves { ok, output, error, code }. Never rejects.
function runKiro({ cwd, sessionId, agent, model, trustTools, prompt, timeoutMs = 300000, onSpawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN(), buildArgs({ sessionId, agent, model, trustTools }), {
        cwd: cwd || process.cwd(),
        env: process.env,
        detached: true, // allows killing the entire process group via process.kill(-pid)
      });
    } catch (e) {
      return resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 });
    }
    if (typeof onSpawn === 'function') onSpawn(child);

    // Deliver the prompt via stdin (handles arbitrarily large / multiline text).
    if (child.stdin) {
      child.stdin.on('error', () => { /* ignore EPIPE if the process exits early */ });
      try { child.stdin.write(prompt || ''); child.stdin.end(); } catch (e) { /* ignore */ }
    }

    let out = '';
    let err = '';
    let killedByTimeout = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { killedByTimeout = true; child.kill('SIGTERM'); }, timeoutMs)
      : null;

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outClean = clean(out).replace(/^>\s?/, '').trim();
      const errClean = clean(err);
      if (killedByTimeout) {
        return resolve({ ok: false, output: outClean, error: `Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`, code: code ?? -1 });
      }
      resolve({ ok: code === 0, output: outClean, error: errClean, code });
    });
  });
}

// List saved sessions for a working directory. Resolves [] on any failure.
function listSessions(cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN(), ['chat', '--list-sessions', '-f', 'json'], { cwd: cwd || process.cwd(), env: process.env });
    } catch { return resolve([]); }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      try {
        const arr = JSON.parse(out);
        const entry = arr.find((e) => e.cwd === (cwd || process.cwd())) || arr[0];
        resolve(entry && Array.isArray(entry.sessions) ? entry.sessions : []);
      } catch { resolve([]); }
    });
  });
}

async function getLatestSessionId(cwd) {
  const s = await listSessions(cwd);
  return s.length ? s[0].sessionId : null; // list is newest-first
}

// List available agents for a directory (global + local). Resolves '' on failure.
function listAgents(cwd) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(BIN(), ['agent', 'list'], { cwd: cwd || process.cwd(), env: process.env }); }
    catch { return resolve(''); }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(clean(out)));
  });
}

// Read all Kiro session files → most-recent-first list (global, cross-directory).
function recentSessions(limit = 8) {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const items = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (!d.session_id) continue;
      items.push({
        id: d.session_id,
        title: (d.title || '').slice(0, 70) || '(untitled)',
        cwd: d.cwd || null,
        agent: (d.session_state || {}).agent_name || null,
        updatedAt: d.updated_at || null,
      });
    } catch { /* skip bad file */ }
  }
  items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return items.slice(0, limit);
}

// Look up a single session by id → { id, title, cwd, agent } or null.
function getSessionInfo(id) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
    return { id: d.session_id, title: d.title || '', cwd: d.cwd || null, agent: (d.session_state || {}).agent_name || null };
  } catch { return null; }
}

// List available models (names) via kiro-cli.
function listModels() {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(BIN(), ['chat', '--list-models', '-f', 'json'], { env: process.env }); }
    catch { return resolve([]); }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => { try { resolve((JSON.parse(out).models || []).map((m) => m.model_name)); } catch { resolve([]); } });
  });
}

module.exports = { runKiro, listSessions, getLatestSessionId, listAgents, recentSessions, getSessionInfo, listModels };
