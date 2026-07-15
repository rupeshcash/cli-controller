// core/brain/cline.js — Cline brain adapter (official `cline` CLI v3.x).
//
// Ground truth (verified 2026-07-14 against cline 3.0.40 on Windows):
//  • Prompt is delivered as a POSITIONAL arg. Piped stdin is NOT detected by cline
//    in --json mode, so stdin delivery does not work — positional is required.
//  • --json emits line-delimited JSON. The final `run_result` event carries
//    { finishReason:"completed", text } but NO taskId. The task id (conv_*) is on
//    `hook_event`/`done` events, and is DIFFERENT from the resume id.
//  • Resume uses the history `sessionId` (e.g. 1784...jb6xe) from `cline history --json`
//    via `--id`. That id is captured by the runner (listSessions diff), not from run output.
//  • Errors surface as {"type":"error","message":...} on stdout OR stderr.
//  • Windows: `cline` resolves to `cline.cmd`; Node cannot spawn a .cmd without a shell
//    (EINVAL). We spawn `node <cline-entry>` directly (no shell, clean args, works on
//    Windows + macOS + Linux). Falls back to a shell spawn only if the entry can't be found.
//  • No single-writer lock. --json => incremental output (streaming brain).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Executable resolution (cross-platform) ─────────────────────────────────
// Pure + injectable so it can be unit-tested without the real filesystem/PATH.
// Returns { cmd, prefix, shell }: spawn(cmd, [...prefix, ...args], { shell }).

// Find cline's JS entry script next to its npm shim on Windows PATH.
// npm global layout: shim `<dir>\cline.cmd` → package `<dir>\node_modules\cline\bin\cline`.
function findClineEntry(pathEnv, exists) {
  for (const dir of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    if (exists(path.join(dir, 'cline.cmd')) || exists(path.join(dir, 'cline'))) {
      const entry = path.join(dir, 'node_modules', 'cline', 'bin', 'cline');
      if (exists(entry)) return entry;
    }
  }
  return null;
}

// Decide how to spawn cline for the given platform/env.
function resolveExec({ platform, env, exists, execPath }) {
  const win = platform === 'win32';
  const override = (env.CLINE_BIN || '').trim();
  if (override) {
    // An explicit JS entry file → run it with node directly.
    if (/\.(c|m)?js$/i.test(override) && exists(override)) return { cmd: execPath, prefix: [override], shell: false };
    // Otherwise treat as a command name (needs a shell on Windows for .cmd shims).
    return { cmd: override, prefix: [], shell: win };
  }
  if (win) {
    const entry = findClineEntry(env.PATH || env.Path || '', exists);
    if (entry) return { cmd: execPath, prefix: [entry], shell: false };  // robust: node-direct
    return { cmd: 'cline', prefix: [], shell: true };                    // last-resort fallback
  }
  // unix/mac: `cline` on PATH is an executable shebang script → spawn directly.
  return { cmd: 'cline', prefix: [], shell: false };
}

function currentExec() {
  return resolveExec({ platform: process.platform, env: process.env, exists: fs.existsSync, execPath: process.execPath });
}

function spawnCline(args, { cwd } = {}) {
  const { cmd, prefix, shell } = currentExec();
  return spawn(cmd, [...prefix, ...args], { cwd: cwd || process.cwd(), env: process.env, shell });
}

// ── Argument building ───────────────────────────────────────────────────────
function buildArgs({ cwd, sessionId, model, provider, trustTools, timeoutMs }) {
  const autoApprove = (trustTools || '').toUpperCase() === 'ALL'; // our trust → Cline auto-approve
  const args = ['--json', '--auto-approve', String(autoApprove), '-c', cwd || process.cwd()];
  if (sessionId) args.push('--id', sessionId);
  if (model) args.push('-m', model);
  if (provider) args.push('-P', provider);
  if (timeoutMs && timeoutMs > 0) args.push('-t', String(Math.round(timeoutMs / 1000)));
  return args;
}

// ── Output parsing (against REAL cline event shapes) ────────────────────────
// Parse line-delimited JSON from stdout. Returns { ok, text, taskId, error, events }.
// NOTE: taskId is the run's conv_* id (for reference/logging) — NOT the resume id.
function parseJsonl(stdout) {
  const events = [];
  let runResult = null, doneText = '', taskId = null, errorMsg = '';
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    events.push(o);
    if (o.type === 'run_result') runResult = o;
    if (o.type === 'error' && o.message) errorMsg = o.message;
    if (!taskId && o.taskId) taskId = o.taskId; // from hook_event agent_start/agent_end
    if (o.type === 'agent_event' && o.event && o.event.type === 'done' && o.event.text) doneText = o.event.text;
  }
  const finish = runResult && runResult.finishReason;
  const ok = !!runResult && finish === 'completed' && !errorMsg;
  const text = (runResult && runResult.text) || doneText || '';
  const error = errorMsg || (runResult && finish && finish !== 'completed' ? `cline finished: ${finish}` : '');
  return { ok, text, taskId: taskId || null, error, events };
}

// cline sometimes prints the JSON error event (or raw text) on stderr. Extract a message.
function parseErrorStream(stderr) {
  const s = String(stderr || '');
  if (!s.trim()) return '';
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && o.type === 'error' && o.message) return o.message; } catch { /* not json */ }
  }
  return s.trim().split('\n')[0];
}

// Strip cline's `<user_input mode="act">…</user_input>` wrapper from a stored prompt.
function cleanPrompt(p) {
  const m = /<user_input[^>]*>([\s\S]*?)<\/user_input>/.exec(String(p || ''));
  return (m ? m[1] : String(p || '')).trim();
}

// ── Run one turn ─────────────────────────────────────────────────────────────
// `_spawn` is an injectable seam for tests (defaults to the real cross-platform spawn).
function runCline({ cwd, sessionId, model, provider, trustTools, prompt, timeoutMs = 0, onSpawn, onData }, _spawn = spawnCline) {
  return new Promise((resolve) => {
    const args = buildArgs({ cwd, sessionId, model, provider, trustTools, timeoutMs });
    args.push(prompt || ''); // positional prompt (piped stdin is not detected by cline)
    let child;
    try { child = _spawn(args, { cwd }); }
    catch (e) { return resolve({ ok: false, output: '', error: `Failed to start cline: ${e.message}`, code: -1 }); }
    if (typeof onSpawn === 'function') onSpawn(child);

    let out = '', err = '', settled = false, timedOut = false, timer = null;
    const finish = (r) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };

    // Enforced kill-timeout: cline can block forever in headless mode when it wants a
    // tool approval that no TTY can grant. Never rely on cline's own -t alone — kill it.
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs + 2000);
    }

    child.stdout.on('data', (d) => { const s = d.toString(); out += s; if (typeof onData === 'function') { try { onData(s); } catch {} } });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, output: '', error: `Failed to start cline: ${e.message}`, code: -1 }));
    child.on('close', (code) => {
      if (timedOut) {
        const p = parseJsonl(out);
        return finish({ ok: false, output: p.text, code: code == null ? -1 : code,
          error: `cline timed out after ${Math.round(timeoutMs / 1000)}s (it may be waiting for tool approval in headless mode — use trust=ALL for autonomous runs, or send a prompt that needs no tools)` });
      }
      const p = parseJsonl(out);
      const error = p.error || (!p.ok ? parseErrorStream(err) : '') || (code !== 0 ? `cline exited with code ${code}` : '');
      finish({
        ok: p.ok && code === 0,
        output: p.text,
        error: p.ok ? '' : error,
        code,
        // Deliberately NOT returning a sessionId: the run's taskId (conv_*) is not the
        // resume id. The runner captures the real history sessionId via a listSessions diff.
      });
    });
  });
}

// ── Session history ───────────────────────────────────────────────────────────
// Normalize `cline history --json` → [{ sessionId, title, cwd, updatedAt }].
function normalizeHistory(arr, cwdHint) {
  return (Array.isArray(arr) ? arr : []).map((e) => ({
    sessionId: e.sessionId || null,
    title: (((e.metadata && e.metadata.title) || e.title || cleanPrompt(e.prompt) || '').slice(0, 70)) || '(untitled)',
    cwd: e.cwd || e.workspaceRoot || null,
    updatedAt: e.updatedAt || e.endedAt || null,
  })).filter((s) => s.sessionId);
}

function listSessions(cwd) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnCline(['history', '--json', '--limit', '100'], { cwd }); }
    catch { return resolve([]); }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => { try { resolve(normalizeHistory(JSON.parse(out), cwd)); } catch { resolve([]); } });
  });
}

// ── Doctor ────────────────────────────────────────────────────────────────────
function isInstalled() {
  const { cmd, prefix, shell } = currentExec();
  const r = spawnSync(cmd, [...prefix, '--version'], { encoding: 'utf8', timeout: 8000, shell });
  return !(r.error || r.status !== 0);
}

const capabilities = { resume: true, agents: false, models: true, sessionStore: true, singleWriterLock: false, incrementalOutput: true };

const adapter = {
  id: 'cline',
  displayName: 'Cline',
  capabilities,
  runTurn: (input) => runCline(input),
  listSessions: (cwd) => listSessions(cwd),
  listAgents: async () => '',        // Cline has plan/act modes, not named agents
  listModels: async () => [],        // models are provider-scoped (via `cline auth`/config)
  recentSessions: async (limit) => (await listSessions()).slice(0, limit).map((s) => ({ ...s, id: s.sessionId, agent: null, locked: false })),
  getSessionInfo: async (id) => (await listSessions()).find((s) => s.sessionId === id) || null,
  prepareResume: async () => ({ action: 'ok' }), // no single-writer lock
  buildResumeCommand: (s) => `cd ${s.cwd || '~'} && cline -c ${s.cwd || '.'} --id ${s.id || s.sessionId}`,
  doctor: async () => { const ok = isInstalled(); return { ok, msg: ok ? 'cline found' : 'cline not found on PATH (npm i -g cline)' }; },
};

module.exports = {
  runCline, listSessions, parseJsonl, parseErrorStream, cleanPrompt,
  normalizeHistory, findClineEntry, resolveExec, buildArgs,
  adapter, capabilities,
};
