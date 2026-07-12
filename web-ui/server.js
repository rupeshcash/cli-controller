const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const os = require('os');
const { getBrain, listBrains, brains: BRAINS } = require('../core/brain');
const runner = require('../core/runner');
const { memory } = require('../core/memory');

const TRUST = process.env.KIRO_TRUST_TOOLS ?? 'fs_read';
const runs = new Map(); // runId -> { id, status, startedAt, endedAt, output, error, sessionId, brain, cwd }

const app = express();
const PORT = process.env.PANEL_PORT || 1234;

// Paths
const SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
const BRIDGE_DIR = path.resolve(__dirname, '..', 'slack-bridge');
const BRIDGE_STATE = path.join(BRIDGE_DIR, 'state.json');
const BRIDGE_LOG = path.join(BRIDGE_DIR, 'bridge.log');
const BRIDGE_PID = path.join(BRIDGE_DIR, 'bridge.pid');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Helpers ───────────────────────────────────────────
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function getBridgeState() {
  return readJSON(BRIDGE_STATE) || {};
}

function getSlackSessionIds() {
  const st = getBridgeState();
  return new Set(Object.values(st).map(v => v.sessionId).filter(Boolean));
}

function isBridgeRunning() {
  try {
    const pid = parseInt(fs.readFileSync(BRIDGE_PID, 'utf8').trim(), 10);
    if (!pid) return { running: false };
    // Cross-platform liveness probe: process.kill(pid, 0) sends no signal, it only
    // checks existence. Throws ESRCH if dead. (Replaces `kill -0`, which doesn't
    // exist on Windows and made the dashboard misreport the bridge as offline.)
    // EPERM means the process exists but is owned by someone else → still "running".
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return { running: false }; }
    return { running: true, pid };
  } catch { return { running: false }; }
}

function loadSessionMeta(file) {
  const d = readJSON(file);
  if (!d || !d.session_id) return null;
  const ss = d.session_state || {};
  const rts = ss.rts_model_state || {};
  // Count messages from .jsonl if it exists
  let messages = 0;
  const jsonlPath = file.replace(/\.json$/, '.jsonl');
  try { messages = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim()).length; } catch {}
  return {
    id: d.session_id,
    title: (d.title || '').slice(0, 120) || '(untitled)',
    agent: ss.agent_name || null,
    cwd: d.cwd || null,
    cwdShort: d.cwd ? path.basename(d.cwd) : null,
    contextPct: rts.context_usage_percentage != null ? Math.round(rts.context_usage_percentage) : null,
    model: (ss.conversation_metadata || {}).model || (rts.model_info || {}).model_name || null,
    messages,
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
    reason: d.session_created_reason || null,
  };
}

// ── API: Status ───────────────────────────────────────
app.get('/api/status', (req, res) => {
  const bridge = isBridgeRunning();
  const slackIds = getSlackSessionIds();
  let sessionCount = 0;
  try { sessionCount = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).length; } catch {}
  res.json({ bridge, threads: slackIds.size, sessions: sessionCount });
});

// ── API: Bridge control ───────────────────────────────
function bridgeCmd(cmd) {
  try { return execSync(`bash ${path.join(BRIDGE_DIR, 'bridge')} ${cmd}`, { encoding: 'utf8', timeout: 15000 }).trim(); }
  catch (e) { return e.stdout || e.message; }
}
app.post('/api/bridge/start', (req, res) => res.json({ ok: true, msg: bridgeCmd('start') }));
app.post('/api/bridge/stop', (req, res) => res.json({ ok: true, msg: bridgeCmd('stop') }));
app.post('/api/bridge/restart', (req, res) => res.json({ ok: true, msg: bridgeCmd('restart') }));

app.get('/api/bridge/logs', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 80, 500);
  const filter = (req.query.filter || '').toLowerCase();
  try {
    let lines = execSync(`tail -n ${n * 3} "${BRIDGE_LOG}"`, { encoding: 'utf8' })
      .replace(/xox[bp]-[A-Za-z0-9-]+/g, '[REDACTED]').split('\n');
    if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter));
    res.json({ lines: lines.slice(-n) });
  } catch { res.json({ lines: ['(no log file)'] }); }
});

app.get('/api/bridge/threads', (req, res) => {
  const st = getBridgeState();
  // kiro-cli --list-sessions is cwd-scoped; scan all unique cwds from state
  let titleMap = {};
  const cwds = [...new Set(Object.values(st).map(v => v.cwd).filter(Boolean))];
  for (const cwd of cwds) {
    try {
      const raw = execSync('kiro-cli chat --list-sessions -f json', { cwd, encoding: 'utf8', timeout: 8000 });
      const entries = JSON.parse(raw);
      entries.forEach(e => (e.sessions || []).forEach(s => {
        titleMap[s.sessionId] = { title: (s.title || '').slice(0, 80), messages: s.messageCount, updatedAt: s.updatedAt };
      }));
    } catch {}
  }
  const threads = Object.entries(st).map(([key, v]) => {
    const info = titleMap[v.sessionId] || {};
    return { key, ...v, title: info.title || null, messages: info.messages || null, lastActive: info.updatedAt || null, cwdShort: v.cwd ? path.basename(v.cwd) : null };
  });
  threads.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
  res.json(threads);
});

// ── API: Sessions (brain-aware: Kiro files + Cline history) ───────────
app.get('/api/sessions', async (req, res) => {
  const { source, agent, brain, sort, q } = req.query;
  const slackIds = getSlackSessionIds();
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')); } catch { files = []; }

  let sessions = files.map(f => loadSessionMeta(path.join(SESSIONS_DIR, f))).filter(Boolean);
  sessions.forEach(s => { s.brain = 'kiro'; s.source = slackIds.has(s.id) ? 'slack' : 'terminal'; });

  // Append Cline sessions (from `cline history --json`), best-effort.
  try {
    const cline = await getBrain('cline').recentSessions(200);
    for (const c of cline) sessions.push({
      id: c.sessionId || c.id, title: c.title, agent: null, cwd: c.cwd || null,
      cwdShort: c.cwd ? path.basename(c.cwd) : null, contextPct: null, model: null,
      messages: null, createdAt: null, updatedAt: c.updatedAt || null, reason: null,
      brain: 'cline', source: slackIds.has(c.sessionId || c.id) ? 'slack' : 'terminal',
    });
  } catch {}

  if (source && source !== 'all') sessions = sessions.filter(s => s.source === source);
  if (agent) sessions = sessions.filter(s => s.agent === agent);
  if (brain && brain !== 'all') sessions = sessions.filter(s => s.brain === brain);
  if (q) { const lq = q.toLowerCase(); sessions = sessions.filter(s => `${s.title} ${s.cwd || ''} ${s.brain} ${s.agent || ''}`.toLowerCase().includes(lq)); }

  const sortKey = sort || 'updated';
  sessions.sort((a, b) => {
    if (sortKey === 'messages') return (b.messages || 0) - (a.messages || 0);
    if (sortKey === 'context') return (b.contextPct || 0) - (a.contextPct || 0);
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  res.json(sessions.slice(0, 300));
});

app.get('/api/sessions/:id', (req, res) => {
  const file = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  const meta = loadSessionMeta(file);
  if (!meta) return res.status(404).json({ error: 'not found' });

  // First + last few messages from .jsonl
  const jsonlPath = file.replace(/\.json$/, '.jsonl');
  let preview = [];
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim());
    const first5 = lines.slice(0, 5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const last5 = lines.length > 10 ? lines.slice(-5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    preview = { first: first5, last: last5, total: lines.length };
  } catch { preview = { first: [], last: [], total: 0 }; }

  meta.source = getSlackSessionIds().has(meta.id) ? 'slack' : 'terminal';
  meta.resumeCmd = `cd ${meta.cwd || '~'} && kiro-cli chat${meta.agent ? ` --agent ${meta.agent}` : ''} --resume-id ${meta.id}`;
  meta.preview = preview;
  res.json(meta);
});

// ── API: Agents list ──────────────────────────────────
app.get('/api/agents', (req, res) => {
  try {
    const out = execSync('kiro-cli agent list', { encoding: 'utf8', timeout: 5000 })
      .replace(/\x1b\[[0-9;]*m/g, '');
    res.json({ raw: out });
  } catch { res.json({ raw: '(could not list agents)' }); }
});

// ── API: Brains (for the web composer) ────────────────
app.get('/api/brains', (req, res) => {
  res.json(listBrains().map(id => ({ id, displayName: BRAINS[id].displayName, capabilities: BRAINS[id].capabilities })));
});

// ── API: Web chat — start / continue a session via core ───────────────
// Resume-lock preflight (e.g. Kiro session live in another PID).
app.post('/api/resume-check', async (req, res) => {
  const { brain, sessionId } = req.body || {};
  try {
    const b = getBrain(brain);
    if (!sessionId || !b.prepareResume) return res.json({ action: 'ok' });
    res.json(await b.prepareResume(sessionId));
  } catch (e) { res.json({ action: 'ok' }); }
});

// Start a run (returns runId immediately; run proceeds async, tracked in `runs`).
app.post('/api/run', async (req, res) => {
  const { brain, cwd, agent, model, sessionId, prompt } = req.body || {};
  if (!cwd || !prompt) return res.status(400).json({ error: 'cwd and prompt are required' });
  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rec = { id, status: 'running', startedAt: Date.now(), endedAt: null, output: '', error: '', sessionId: sessionId || null, brain: brain || 'kiro', cwd };
  runs.set(id, rec);
  res.json({ runId: id });
  runner.runTurn({ brain, cwd, agent, model, sessionId, prompt, trustTools: TRUST, timeoutMs: 0 })
    .then((r) => {
      if (r.blocked) { Object.assign(rec, { status: 'blocked', blocked: r.blocked, endedAt: Date.now() }); return; }
      Object.assign(rec, { status: r.ok ? 'done' : 'error', output: r.output || '', error: r.error || '', sessionId: r.sessionId || rec.sessionId, endedAt: Date.now() });
    })
    .catch((e) => Object.assign(rec, { status: 'error', error: String(e.message || e), endedAt: Date.now() }));
});

app.get('/api/runs/:id', (req, res) => {
  const r = runs.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

// SSE: lifecycle + elapsed (NOT content streaming — brains block-buffer; see architecture §5).
app.get('/api/runs/:id/events', (req, res) => {
  const r = runs.get(req.params.id);
  if (!r) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = () => res.write(`data: ${JSON.stringify({ status: r.status, elapsedMs: (r.endedAt || Date.now()) - r.startedAt, sessionId: r.sessionId, output: r.status === 'done' ? r.output : undefined, error: r.error || undefined, blocked: r.blocked || undefined })}\n\n`);
  send();
  const t = setInterval(() => { send(); if (r.status !== 'running') { clearInterval(t); res.end(); } }, 1000);
  req.on('close', () => clearInterval(t));
});

// ── API: Manager memory (search / recent) ────────────
app.get('/api/memory/search', (req, res) => {
  try { res.json(memory().search(req.query.q || '', { limit: Math.min(parseInt(req.query.limit, 10) || 8, 25) })); }
  catch { res.json([]); }
});
app.get('/api/memory/recent', (req, res) => {
  try { res.json(memory().recent({ limit: Math.min(parseInt(req.query.limit, 10) || 10, 50) })); }
  catch { res.json([]); }
});

// ── SPA fallback ──────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`⚡ Kiro Control Panel running at http://localhost:${PORT}`);
});
