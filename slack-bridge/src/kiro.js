// src/kiro.js — thin wrapper around `kiro-cli chat` in headless mode.
// Uses spawn with an args array (never a shell string) to avoid command injection.
const { spawn } = require('child_process');

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

function buildArgs({ sessionId, agent, model, trustTools, prompt }) {
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

  args.push(prompt); // positional [INPUT] = the question to ask
  return args;
}

// Run one headless turn. Resolves { ok, output, error, code }. Never rejects.
function runKiro({ cwd, sessionId, agent, model, trustTools, prompt, timeoutMs = 300000, onSpawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN(), buildArgs({ sessionId, agent, model, trustTools, prompt }), {
        cwd: cwd || process.cwd(),
        env: process.env,
      });
    } catch (e) {
      return resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 });
    }
    if (typeof onSpawn === 'function') onSpawn(child);

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

module.exports = { runKiro, listSessions, getLatestSessionId, listAgents };
