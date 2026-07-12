// core/brain/cline.js — Cline brain adapter (official `cline` CLI v3.x).
// Verified surface (spike 2026-07-11): headless by default, --json emits
// line-delimited JSON events, resume via --id, sessions via `cline history --json`,
// model via -m / provider via -P / key via -k, trust via --auto-approve.
// No single-writer lock. --json => incremental output (streaming brain).
const { spawnCli, spawnCliSync, resolveCommand } = require('../spawn');

const BIN = () => process.env.CLINE_BIN || 'cline';

function buildArgs({ cwd, sessionId, model, provider, trustTools, timeoutMs }) {
  const autoApprove = (trustTools || '').toUpperCase() === 'ALL'; // map our trust → Cline auto-approve
  const args = ['-c', cwd || process.cwd(), '--json', '--auto-approve', String(autoApprove)];
  if (sessionId) args.push('--id', sessionId);
  if (model) args.push('-m', model);
  if (provider) args.push('-P', provider);
  if (timeoutMs && timeoutMs > 0) args.push('-t', String(Math.round(timeoutMs / 1000)));
  return args;
}

// Parse Cline's line-delimited JSON. Returns { ok, text, sessionId, error, events }.
function parseJsonl(stdout) {
  const events = [];
  let runResult = null;
  let errorMsg = '';
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    events.push(obj);
    if (obj.type === 'run_result') runResult = obj;
    if (obj.type === 'error' && obj.message) errorMsg = obj.message;
  }
  const finished = runResult && runResult.finishReason;
  const isError = !runResult || finished === 'error';
  return {
    ok: !isError,
    text: (runResult && runResult.text) || '',
    sessionId: (runResult && runResult.taskId) || null,
    error: errorMsg || (isError && runResult ? runResult.text : '') || '',
    events,
  };
}

function normalizeHistory(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || '[]'); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.sessions) ? parsed.sessions : []);
  return arr.map((e) => ({
    sessionId: e.id || e.sessionId || e.taskId || e.conversationId || null,
    title: (e.title || e.task || e.name || e.summary || '').slice(0, 70) || '(untitled)',
    cwd: e.cwd || e.workspace || null,
    updatedAt: e.updatedAt || e.updated_at || e.ts || null,
  })).filter((s) => s.sessionId);
}

// Run one turn. Prompt via positional arg (spawn args array → no shell injection).
function runCline({ cwd, sessionId, model, provider, trustTools, prompt, timeoutMs = 0, onSpawn, onData }) {
  return new Promise((resolve) => {
    const args = buildArgs({ cwd, sessionId, model, provider, trustTools, timeoutMs });
    args.push(prompt || '');
    let child;
    try { child = spawnCli(BIN(), args, { cwd: cwd || process.cwd(), env: process.env }); }
    catch (e) { return resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 }); }
    if (typeof onSpawn === 'function') onSpawn(child);
    let out = '', err = '';
    child.stdout.on('data', (d) => { const s = d.toString(); out += s; if (typeof onData === 'function') { try { onData(s); } catch {} } });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, output: '', error: `Failed to start ${BIN()}: ${e.message}`, code: -1 }));
    child.on('close', (code) => {
      const parsed = parseJsonl(out);
      resolve({
        ok: parsed.ok && code === 0,
        output: parsed.text,
        error: parsed.error || (code !== 0 ? (err.trim() || `cline exited with code ${code}`) : ''),
        code,
        sessionId: parsed.sessionId || undefined,
      });
    });
  });
}

// List sessions via `cline history --json`. Normalize to [{ sessionId, title, cwd, updatedAt }].
function listSessions(cwd) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnCli(BIN(), ['history', '--json', '--limit', '100'], { cwd: cwd || process.cwd(), env: process.env }); }
    catch { return resolve([]); }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      try {
        resolve(normalizeHistory(out));
      } catch { resolve([]); }
    });
  });
}

function isInstalled() {
  const r = spawnCliSync(BIN(), ['--version'], { encoding: 'utf8', timeout: 6000 });
  return !(r.error || r.status !== 0);
}

const capabilities = { resume: true, agents: false, models: true, sessionStore: true, singleWriterLock: false, incrementalOutput: true };

const adapter = {
  id: 'cline',
  displayName: 'Cline',
  capabilities,
  runTurn: (input) => runCline(input),
  listSessions: (cwd) => listSessions(cwd),
  listAgents: async () => '',                 // Cline has plan/act modes, not named agents
  listModels: async () => [],                 // models are provider-scoped; via `cline auth`/config
  recentSessions: async (limit) => (await listSessions()).slice(0, limit).map((s) => ({ ...s, id: s.sessionId, agent: null, locked: false })),
  getSessionInfo: async (id) => (await listSessions()).find((s) => s.sessionId === id) || null,
  prepareResume: async () => ({ action: 'ok' }),   // no single-writer lock
  buildResumeCommand: (s) => `cd ${s.cwd || '~'} && ${resolveCommand(BIN())} -c ${s.cwd || '.'} --id ${s.id || s.sessionId}`,
  doctor: async () => ({ ok: isInstalled(), msg: isInstalled() ? 'cline found' : 'cline not found on PATH (npm i -g cline)' }),
};

module.exports = { runCline, listSessions, parseJsonl, normalizeHistory, buildArgs, adapter, capabilities };
