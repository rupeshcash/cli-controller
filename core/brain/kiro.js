// core/brain/kiro.js — Kiro brain: low-level `kiro-cli chat` wrapper + Brain adapter.
// Uses spawn with an args array (never a shell string) to avoid command injection.
// The prompt is delivered via stdin (robust for large/multiline text).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
const BIN = () => process.env.KIRO_BIN || 'kiro-cli';

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function clean(s) {
  return (s || '').replace(ANSI, '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildArgs({ sessionId, agent, model, trustTools }) {
  const args = ['chat', '--no-interactive'];
  if (sessionId) args.push('--resume-id', sessionId);
  if (agent) args.push('--agent', agent);
  if (model) args.push('--model', model);
  if ((trustTools || '').toUpperCase() === 'ALL') args.push('--trust-all-tools');
  else args.push(`--trust-tools=${trustTools || ''}`);
  return args;
}

// Run one headless turn. Resolves { ok, output, error, code }. Never rejects.
function runKiro({ cwd, sessionId, agent, model, trustTools, prompt, timeoutMs = 300000, onSpawn, onData }) {
  return new Promise((resolve) => {
    let child;
    try {
      // detached only on POSIX (enables !abort group-kill); on Windows it strips kiro-cli's console handles → "handle is invalid (os error 6)".
      const posix = process.platform !== 'win32';
      child = spawn(BIN(), buildArgs({ sessionId, agent, model, trustTools }), {
        cwd: cwd || process.cwd(), env: process.env, detached: posix, windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 });
    }
    if (typeof onSpawn === 'function') onSpawn(child);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.write(prompt || ''); child.stdin.end(); } catch {}
    }
    let out = '', err = '', killedByTimeout = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { killedByTimeout = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { const s = d.toString(); out += s; if (typeof onData === 'function') { try { onData(s); } catch {} } });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outClean = clean(out).replace(/^>\s?/, '').trim();
      if (killedByTimeout) return resolve({ ok: false, output: outClean, error: `Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`, code: code ?? -1 });
      resolve({ ok: code === 0, output: outClean, error: clean(err), code });
    });
  });
}

function listSessions(cwd) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(BIN(), ['chat', '--list-sessions', '-f', 'json'], { cwd: cwd || process.cwd(), env: process.env }); }
    catch { return resolve([]); }
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
  return s.length ? s[0].sessionId : null;
}

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

// Read all Kiro session files → most-recent-first (global, cross-directory).
function recentSessions(limit = 8) {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const items = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (!d.session_id) continue;
      items.push({
        id: d.session_id, title: (d.title || '').slice(0, 70) || '(untitled)',
        cwd: d.cwd || null, agent: (d.session_state || {}).agent_name || null,
        updatedAt: d.updated_at || null, locked: false,
      });
    } catch {}
  }
  items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const top = items.slice(0, limit);
  for (const s of top) s.locked = !!sessionLock(s.id);
  return top;
}

function getSessionInfo(id) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
    return { id: d.session_id, title: d.title || '', cwd: d.cwd || null, agent: (d.session_state || {}).agent_name || null };
  } catch { return null; }
}

function sessionLock(id) {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.lock`), 'utf8')).pid;
    if (!pid) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

// Force-release a locked session: terminate the holding process and clear the stale .lock. Best-effort, never throws.
function forceUnlock(id) {
  const pid = sessionLock(id);
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }, 2000);
  }
  try { fs.unlinkSync(path.join(SESSIONS_DIR, `${id}.lock`)); } catch {}
  return { killed: pid || null };
}

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

function isInstalled() {
  const r = require('child_process').spawnSync(BIN(), ['--version'], { encoding: 'utf8', timeout: 6000, shell: process.platform === 'win32' });
  return !(r.error || r.status !== 0);
}

// ── Brain adapter (contract: see plans/roadmap/01-brain-multi-cli.md §3) ──
const capabilities = { resume: true, agents: true, models: true, sessionStore: true, singleWriterLock: true, incrementalOutput: false };

const adapter = {
  id: 'kiro',
  displayName: 'Kiro',
  capabilities,
  runTurn: (input) => runKiro(input),
  // Normalized session listing → [{ sessionId, ... }]
  listSessions: (cwd) => listSessions(cwd),
  listAgents: (cwd) => listAgents(cwd),
  listModels: () => listModels(),
  recentSessions: (limit) => recentSessions(limit),
  getSessionInfo: (id) => getSessionInfo(id),
  // Kiro has a single-writer lock: refuse to resume a session live in another PID.
  prepareResume: async (id) => {
    const pid = sessionLock(id);
    if (!pid) return { action: 'ok' };
    return { action: 'blocked', pid, reason: `This session is open in another live process (pid ${pid}).`, options: ['take-over', 'read-only', 'cancel'] };
  },
  buildResumeCommand: (s) => `cd ${s.cwd || '~'} && kiro-cli chat${s.agent ? ` --agent ${s.agent}` : ''} --resume-id ${s.id}`,
  forceUnlock: (id) => forceUnlock(id),
  doctor: async () => ({ ok: isInstalled(), msg: isInstalled() ? 'kiro-cli found' : "kiro-cli not found on PATH" }),
};

module.exports = {
  // low-level (kept for import compatibility)
  runKiro, listSessions, getLatestSessionId, listAgents, recentSessions, getSessionInfo, sessionLock, forceUnlock, listModels,
  // brain
  adapter, capabilities,
};
