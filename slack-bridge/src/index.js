#!/usr/bin/env node
// src/index.js — Slack bridge (Socket Mode). Model: THREAD = SESSION.
//
//   • Send ANY message            → starts a new AI CLI session; the bot replies in a thread.
//   • Reply inside that thread     → continues the same session (no command).
//   • Each top-level message       → an independent, parallel session (its own thread).
//   • Default agent: `main` (configurable). Reactions show status: ⏳ → ✅ / ❌.
//
require('dotenv').config();
const os = require('os');
const path = require('path');
const { App } = require('@slack/bolt');
const brains = require('../../core/brain');
const { route } = require('./broker');
const store = require('./sessions');
const { chunk } = require('./chunk');
const { stripToolTrace, toSlack } = require('./format');

function rel(d) { if (!d) return '—'; const s = Math.floor((Date.now() - new Date(d)) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }

// ── Config ──────────────────────────────────────────────────────────────────
const RAW_ALLOWED = (process.env.SLACK_ALLOWED_USER_IDS || '').trim();
const ALLOW_ALL = RAW_ALLOWED === '*' || RAW_ALLOWED.toUpperCase() === 'ALL';
const ALLOWED = ALLOW_ALL ? [] : RAW_ALLOWED.split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_TOOLS = process.env.KIRO_TRUST_TOOLS ?? 'fs_read';
const DEFAULT_BRAIN = (process.env.CLI_CONTROLLER_DEFAULT_BRAIN || process.env.KIRO_DEFAULT_BRAIN || brains.DEFAULT_BRAIN || 'kiro').toLowerCase();
const DEFAULT_CWD = process.env.KIRO_DEFAULT_CWD || process.cwd();
const DEFAULT_AGENT = process.env.KIRO_AGENT || 'main';
const DEFAULT_MODEL = process.env.KIRO_MODEL || null;
const TIMEOUT_MS = Number.isFinite(parseInt(process.env.KIRO_TIMEOUT_MS, 10))
  ? parseInt(process.env.KIRO_TIMEOUT_MS, 10) : 0; // 0 = no timeout (default)
// Output longer than this (chars) is uploaded as a Slack file snippet instead of
// being split into multiple numbered messages. Default = one Slack message worth.
const SNIPPET_THRESHOLD = Number.isFinite(parseInt(process.env.KIRO_SNIPPET_THRESHOLD, 10))
  ? parseInt(process.env.KIRO_SNIPPET_THRESHOLD, 10) : 3800;

// Directory aliases: KIRO_DIR_ALIASES="api:~/projects/api,web:~/projects/web"
const DIR_ALIASES = (process.env.KIRO_DIR_ALIASES || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .reduce((acc, pair) => {
    const i = pair.indexOf(':');
    if (i > 0) acc[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    return acc;
  }, {});

function expandHome(p) { return p && p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p; }
function resolveDir(v) { return expandHome(DIR_ALIASES[v] || v); }

// Natural-language routing broker (plain messages → decide dir/agent/model).
const BROKER_ON = process.env.KIRO_BROKER !== '0' && DEFAULT_BRAIN === 'kiro';
const BROKER_MODEL = process.env.KIRO_BROKER_MODEL || 'claude-haiku-4.5';
let AGENTS_RAW = '';
let MODELS_CACHE = [];
function brokerCtx() {
  return { aliases: DIR_ALIASES, quick: QUICK_ALIASES, agentsRaw: AGENTS_RAW, models: MODELS_CACHE, defaultAgent: DEFAULT_AGENT, defaultCwd: DEFAULT_CWD };
}

function brainFor(id) { return brains.getBrain((id || DEFAULT_BRAIN || 'kiro').toLowerCase()); }
function brainIdForState(st) { return (st && st.brain) || DEFAULT_BRAIN || 'kiro'; }
function brainLabel(id) { const b = brainFor(id); return b.displayName || b.id || id || 'AI'; }
async function listSessionsFor(stOrCwd) {
  const st = typeof stOrCwd === 'object' ? stOrCwd : { cwd: stOrCwd, brain: DEFAULT_BRAIN };
  return brainFor(brainIdForState(st)).listSessions(st.cwd);
}
async function captureNewSession(st, beforeIds) {
  const now = await listSessionsFor(st);
  const fresh = now.find((s) => !beforeIds.has(s.sessionId));
  return (fresh && fresh.sessionId) || null;
}

function rememberThreadSession(threadKey, st, prompt, res) {
  const sid = res && res.sessionId;
  if (!sid) return;
  try {
    const mem = require('../../core/memory').memory();
    mem.recordSession({ sessionId: sid, brain: brainIdForState(st), cwd: st.cwd, title: (prompt || '').slice(0, 70) });
    mem.recordTurn({ sessionId: sid, prompt, summary: ((res.output || res.error || '')).slice(0, 240), tags: [brainIdForState(st), path.basename(st.cwd || '')].filter(Boolean) });
    mem.linkThread(threadKey, sid);
  } catch { /* memory is best-effort */ }
}

// Quick aliases: KIRO_QUICK_ALIASES="name:dir|model|agent, name2:dir|model"
// e.g. 25-opus:~/Documents/armorcode-2025|claude-opus-4.8|main
const QUICK_ALIASES = (process.env.KIRO_QUICK_ALIASES || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .reduce((acc, entry) => {
    const i = entry.indexOf(':');
    if (i < 0) return acc;
    const name = entry.slice(0, i).trim().toLowerCase();
    const [cwd, model, agent] = entry.slice(i + 1).split('|').map((x) => (x || '').trim());
    if (name && cwd) acc[name] = { cwd: expandHome(cwd), model: model || DEFAULT_MODEL, agent: agent || DEFAULT_AGENT };
    return acc;
  }, {});

// ── Startup validation (before App construction) ──────────────────────────────
{
  const missing = [];
  if (!process.env.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!process.env.SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN');
  if (missing.length) {
    console.error(`Missing ${missing.join(' and ')}. Copy .env.example to .env (see SETUP.md).`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// threadKey ("channel:rootTs") -> running child process (abort + single-flight per thread)
const running = new Map();
// threadKey -> { startedAt, buf } live output of the in-flight run (for !peek)
const progress = new Map();

function ansiStrip(s) { return (s || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\r/g, '\n'); }
function livePeek(threadKey) {
  const p = progress.get(threadKey);
  if (!p) return null;
  const secs = Math.floor((Date.now() - p.startedAt) / 1000);
  const mins = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const tail = ansiStrip(p.buf).replace(/\n{3,}/g, '\n\n').trim().slice(-1600);
  if (tail) return `⏳ *Running ${mins}* — latest activity:\n\`\`\`\n${tail}\n\`\`\``;
  return `⏳ *AI CLI is still working — ${mins} elapsed.*\nOutput arrives when the turn completes. Send \`!abort\` to cancel.`;
}
// threadKeys whose current run was aborted — suppresses output from the dying process.
const aborted = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────
function helpText() {
  const aliasNames = Object.keys(DIR_ALIASES);
  const quickNames = Object.keys(QUICK_ALIASES);
  const ws = aliasNames.length ? aliasNames[0] : 'myrepo';
  const lines = [
    `:zap: *CLI Controller* — run ${brainLabel(DEFAULT_BRAIN)} from Slack. Each thread = one session.`,
    '',
    '━━ *How it works* ━━',
    '• *Send any message* → starts a new session; I reply in a :thread: *thread*.',
    '• *Reply inside that thread* → continues the same session (full context).',
    '• Each new top-level message → a separate, *parallel* session.',
    `• Defaults: brain \`${DEFAULT_BRAIN}\` · agent \`${DEFAULT_AGENT}\` · dir \`${DEFAULT_CWD}\` · verbose on.`,
    '',
    '━━ *Start a session* ━━',
    '• Just describe what you want, naturally — a router picks the repo/agent/model for you.',
    '   e.g. `in the 2025 java-utils repo, use opus to fix the failing SLA test`',
    `• \`!new ${ws} run the unit tests\` — explicit workspace`,
    '• `!new brain=cline dir=~/path provider=anthropic model=claude-opus-4.8 <task>` — full control',
    '• `!new -q <task>` — quiet (answer only, no tool trace)',
  ];
  if (quickNames.length) lines.push(`• Quick starts: ${quickNames.map((a) => '`!' + a + '`').join(' · ')}`);
  if (aliasNames.length) lines.push(`• Workspaces: ${aliasNames.map((a) => '`' + a + '`').join(' · ')}`);
  lines.push(
    '',
    '━━ *Inside a thread* ━━',
    '• `!peek` / `!status` — is it still running? how long? / session info',
    '• `!abort` — stop the current task',
    '• `!model <name>` / `!provider <name>` — switch model/provider  ·  `!agent <name>` — switch agent',
    '• `!verbose` — toggle full tool trace vs answer-only',
    '• `!clear` — fresh session (same thread)  ·  `!end` — close session',
    '',
    '━━ *Find & resume any session* ━━',
    `• \`!recent [n]\` — list recent ${brainLabel(DEFAULT_BRAIN)} sessions (terminal *and* Slack where supported)`,
    '• `!teleport <sessionId>` — pull any session into a thread & continue it',
    '',
    '━━ *Info* ━━',
    '• `!agents` — list agents  ·  `!models` — list models  ·  `!help` — this',
    '',
    '_Status reactions:_ :hourglass_flowing_sand: working → :white_check_mark: done · :x: error',
  );
  return lines.filter((l) => l !== null).join('\n');
}

function parseNew(text) {
  let rest = text.slice(4).trim(); // after "!new"
  const patch = {};
  const optRe = /^(brain|tool|agent|dir|cwd|model|provider|verbose)\s*=\s*(\S+)\s*/i;
  const flagVRe = /^(?:-v|--verbose)(?:\s+|$)/i;
  const flagQRe = /^(?:-q|--quiet)(?:\s+|$)/i;
  for (;;) {
    let m;
    if ((m = rest.match(optRe))) {
      const k = m[1].toLowerCase(); const v = m[2];
      if (k === 'brain' || k === 'tool') patch.brain = v.toLowerCase();
      else if (k === 'agent') patch.agent = v;
      else if (k === 'dir' || k === 'cwd') patch.cwd = resolveDir(v);
      else if (k === 'model') patch.model = v;
      else if (k === 'provider') patch.provider = v;
      else if (k === 'verbose') patch.verbose = /^(true|on|yes|1)$/i.test(v);
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((m = rest.match(flagVRe))) { patch.verbose = true; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(flagQRe))) { patch.verbose = false; rest = rest.slice(m[0].length); continue; }
    break;
  }
  // Bare first token as a directory: a known alias, or something that looks like a path.
  if (patch.cwd === undefined) {
    const first = rest.split(/\s+/)[0] || '';
    if (DIR_ALIASES[first]) { patch.cwd = resolveDir(first); rest = rest.slice(first.length).trim(); }
    else if (first.startsWith('/') || first.startsWith('~')) { patch.cwd = expandHome(first); rest = rest.slice(first.length).trim(); }
  }
  return { patch, prompt: rest.trim() };
}

async function sayThread(say, thread_ts, text) {
  for (const part of chunk(text)) await say({ thread_ts, text: part });
}

// Send AI CLI output to the thread: inline (chunked) if small, else as a file snippet.
async function sendOutput({ client, say, channel, thread_ts, text, verbose }) {
  const raw = text && text.trim() ? text : '(no output)';
  const shown = verbose ? raw : stripToolTrace(raw);
  const finalText = shown && shown.trim() ? shown : raw; // never send empty when there was output
  if (finalText.length <= SNIPPET_THRESHOLD) return sayThread(say, thread_ts, toSlack(finalText));
  try {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts,
      filename: 'ai-response.md',
      title: 'AI output',
      initial_comment: `📄 Long output (${finalText.length.toLocaleString()} chars) — attached:`,
      content: finalText, // raw Markdown in the downloadable file
    });
  } catch (e) {
    await sayThread(say, thread_ts, toSlack(finalText)); // fallback to inline if upload fails
  }
}

// Reactions (graceful: no-op if the reactions:write scope isn't granted).
async function react(client, channel, ts, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await client.reactions.add({ channel, timestamp: ts, name }); return true; }
    catch (e) {
      const err = (e && e.data && e.data.error) || (e && e.message) || 'unknown';
      if (err === 'already_reacted') return true;                 // reaction is already there — success
      if (err === 'ratelimited' || (e && e.code === 'slack_webapi_platform_error' && err === 'ratelimited') || (e && e.code === 'slack_webapi_rate_limited_error')) {
        await new Promise((r) => setTimeout(r, ((e && e.retryAfter) || 1) * 1000));
        continue;                                                  // retry after Slack's backoff
      }
      console.log('[react fail]', name, err);
      return false;
    }
  }
  return false;
}
async function unreact(client, channel, ts, name) {
  try { await client.reactions.remove({ channel, timestamp: ts, name }); }
  catch (e) { const err = (e && e.data && e.data.error); if (err && err !== 'no_reaction' && err !== 'message_not_found') console.log('[unreact]', name, err); }
}

async function runTurn({ threadKey, thread_ts, reactTs, channel, prompt, say, client }) {
  if (running.has(threadKey)) {
    return say({ thread_ts, text: '⏳ Still working in this thread. Send `!abort` to cancel it first.' });
  }
  const st = store.get(threadKey);
  const brain = brainFor(brainIdForState(st));
  const isFresh = !st.sessionId;
  console.log(`[turn] ${threadKey} brain=${brain.id} fresh=${isFresh} dir=${st.cwd} agent=${st.agent || 'default'} promptLen=${prompt.length}`);

  // Session header card — shown once per session (not repeated on the first prompt).
  if (isFresh && !st.announced) {
    await say({ thread_ts, text: `:thread: *New ${brainLabel(brain.id)} session* · dir \`${st.cwd}\` · agent \`${st.agent || 'default'}\`${st.model ? ` · model \`${st.model}\`` : ''}${st.provider ? ` · provider \`${st.provider}\`` : ''}` });
    store.set(threadKey, { announced: true });
  }

  // Status via reaction; fall back to a text note if reactions aren't permitted.
  const reactedOk = await react(client, channel, reactTs, 'hourglass_flowing_sand');
  if (!reactedOk) await say({ thread_ts, text: `🤔 ${brainLabel(brain.id)} is working…` });

  const beforeIds = isFresh ? new Set((await listSessionsFor(st)).map((s) => s.sessionId)) : new Set();

  const prog = { startedAt: Date.now(), buf: '' };
  progress.set(threadKey, prog);
  const onData = (c) => { prog.buf += c; if (prog.buf.length > 24000) prog.buf = prog.buf.slice(-24000); };

  let res = await brain.runTurn({
    cwd: st.cwd, sessionId: st.sessionId, agent: st.agent, model: st.model,
    provider: st.provider, trustTools: TRUST_TOOLS, prompt, timeoutMs: TIMEOUT_MS, onSpawn: (c) => running.set(threadKey, c), onData,
  });
  running.delete(threadKey);

  // If this run was aborted, suppress all output — user already got the abort ack.
  if (aborted.has(threadKey)) {
    aborted.delete(threadKey);
    progress.delete(threadKey);
    if (reactedOk) await unreact(client, channel, reactTs, 'hourglass_flowing_sand');
    console.log(`[turn aborted] ${threadKey} — suppressing output`);
    return;
  }

  // Resume-failure fallback: stale session id → start fresh once.
  if (!res.ok && !isFresh && /session|not found|no conversation|resume/i.test(res.error || '')) {
    await say({ thread_ts, text: '↻ Couldn’t resume the previous session — starting a fresh one for this thread.' });
    const before2 = new Set((await listSessionsFor(st)).map((s) => s.sessionId));
    res = await brain.runTurn({
      cwd: st.cwd, sessionId: null, agent: st.agent, model: st.model,
      provider: st.provider, trustTools: TRUST_TOOLS, prompt, timeoutMs: TIMEOUT_MS, onSpawn: (c) => running.set(threadKey, c), onData,
    });
    running.delete(threadKey);
    const sid2 = res.sessionId || await captureNewSession(st, before2); if (sid2) store.set(threadKey, { sessionId: sid2 });
  } else if (isFresh) {
    // Capture even on failure: a transient backend error may still create the
    // session (with the user's message), so a retry can resume WITH context
    // instead of zoning out into a brand-new session.
    const sid = res.sessionId || await captureNewSession(st, beforeIds);
    if (sid) store.set(threadKey, { sessionId: sid });
  }
  rememberThreadSession(threadKey, { ...st, sessionId: store.get(threadKey).sessionId }, prompt, { ...res, sessionId: store.get(threadKey).sessionId || res.sessionId });
  progress.delete(threadKey);

  // Finalize status reaction.
  if (reactedOk) {
    await unreact(client, channel, reactTs, 'hourglass_flowing_sand');
    await react(client, channel, reactTs, res.ok ? 'white_check_mark' : 'x');
  }
  console.log(`[turn done] ${threadKey} ok=${res.ok} code=${res.code} outLen=${(res.output || '').length} err=${(res.error || '').slice(0, 120)}`);

  if (!res.ok && !res.output) {
    const st2 = store.get(threadKey);
    const hint = st2.sessionId
      ? `\n\n_This turn failed (often a transient ${brainLabel(brain.id)} backend error). Just send your message again — the session is kept, so I retry with full context._`
      : '\n\n_This turn failed before a session was established. Send your message again to retry._';
    return sayThread(say, thread_ts, `⚠️ ${res.error || `${brainLabel(brain.id)} exited with code ${res.code}.`}${hint}`);
  }
  await sendOutput({ client, say, channel, thread_ts, text: res.output, verbose: st.verbose });
  if (!res.ok && res.error) await sayThread(say, thread_ts, `_error:_\n${res.error}`);
}

async function startSession({ threadKey, rootTs, reactTs, channel, patch, prompt, say, client }) {
  store.set(threadKey, {
    brain: patch.brain || DEFAULT_BRAIN,
    cwd: patch.cwd || DEFAULT_CWD,
    agent: patch.agent !== undefined ? patch.agent : DEFAULT_AGENT,
    model: patch.model !== undefined ? patch.model : DEFAULT_MODEL,
    provider: patch.provider || null,
    verbose: patch.verbose !== undefined ? patch.verbose : true,
    sessionId: null,
  });
  if (prompt) return runTurn({ threadKey, thread_ts: rootTs, reactTs, channel, prompt, say, client });
  const s = store.get(threadKey);
  store.set(threadKey, { announced: true });
  return say({ thread_ts: rootTs, text: `:thread: *New ${brainLabel(s.brain)} session* · dir \`${s.cwd}\` · agent \`${s.agent || 'default'}\`${s.provider ? ` · provider \`${s.provider}\`` : ''}\nReply in this thread to continue.` });
}

// ── Message handling ────────────────────────────────────────────────────────
async function handleMessage({ message, say, client }) {
  if (message.channel_type !== 'im') return;            // DMs only
  if (message.subtype || message.bot_id) return;         // ignore edits/joins/our own
  if (!ALLOW_ALL && !ALLOWED.includes(message.user)) return;

  const text = (message.text || '').trim();
  if (!text) return;

  const channel = message.channel;
  const isThreadReply = !!message.thread_ts && message.thread_ts !== message.ts;
  const rootTs = message.thread_ts || message.ts;
  const threadKey = `${channel}:${rootTs}`;
  const lower = text.toLowerCase();

  // Global commands
  if (lower === '!help') return say({ thread_ts: rootTs, text: helpText() });
  if (lower === '!agents') {
    const cwd = store.has(threadKey) ? store.get(threadKey).cwd : DEFAULT_CWD;
    const b = store.has(threadKey) ? brainFor(brainIdForState(store.get(threadKey))) : brainFor(DEFAULT_BRAIN);
    const list = b.listAgents ? await b.listAgents(cwd) : '';
    return say({ thread_ts: rootTs, text: list ? `*Agents* (in \`${cwd}\`):\n\`\`\`\n${list.slice(0, 3000)}\n\`\`\`` : 'Could not list agents.' });
  }
  if (lower === '!models') {
    const b = store.has(threadKey) ? brainFor(brainIdForState(store.get(threadKey))) : brainFor(DEFAULT_BRAIN);
    const models = b.listModels ? await b.listModels() : [];
    return say({ thread_ts: rootTs, text: models.length ? `*Models:*\n${models.map((m) => `• \`${m}\``).join('\n')}\n\n_Set with_ \`!model <name>\`` : 'Could not list models.' });
  }
  if (lower.startsWith('!recent')) {
    const n = Math.min(parseInt(text.split(/\s+/)[1], 10) || 8, 20);
    const b = brainFor(DEFAULT_BRAIN);
    const items = b.recentSessions ? await b.recentSessions(n) : [];
    if (!items.length) return say({ thread_ts: rootTs, text: 'No sessions found.' });
    const body = items.map((s, i) => `*${i + 1}.* ${s.locked ? ':lock: ' : ''}${s.title}\n   \`${s.id || s.sessionId}\`\n   ${s.agent || b.id} · \`${s.cwd ? path.basename(s.cwd) : '~'}\` · ${rel(s.updatedAt)}`).join('\n\n');
    return say({ thread_ts: rootTs, text: `*Recent ${brainLabel(b.id)} sessions* (${items.length}):\n\n${body}\n\n_Continue any of them here with_ \`!teleport <sessionId>\`  ·  :lock: = currently open elsewhere` });
  }
  if (lower.startsWith('!teleport')) {
    const id = (text.split(/\s+/)[1] || '').trim();
    if (!id) return say({ thread_ts: rootTs, text: 'Usage: `!teleport <sessionId>` — pull any session from the default brain into a Slack thread. See `!recent`.' });
    const b = brainFor(DEFAULT_BRAIN);
    const info = b.getSessionInfo ? await b.getSessionInfo(id) : null;
    const plan = b.prepareResume ? await b.prepareResume(id) : { action: 'ok' };
    const lockPid = plan && plan.action === 'blocked' ? plan.pid : null;
    store.set(threadKey, {
      brain: b.id,
      cwd: (info && info.cwd) || DEFAULT_CWD,
      agent: (info && info.agent) || DEFAULT_AGENT,
      model: DEFAULT_MODEL,
      verbose: true,
      sessionId: id,
      announced: true,
    });
    const meta = info
      ? `${info.title ? `*${info.title.slice(0, 70)}*\n` : ''}brain \`${b.id}\` · dir \`${path.basename(info.cwd || '~')}\` · agent \`${info.agent || 'default'}\``
      : '_(session file not found — using default dir; resume may start fresh)_';
    const lockWarn = lockPid
      ? `\n\n:warning: *This session is currently open in another process* (pid ${lockPid}) — likely a terminal/TUI. Continuing here at the same time will conflict and give stale replies. *Close it there first.*`
      : '';
    return say({ thread_ts: rootTs, text: `🛸 *Teleported* \`${id.slice(0, 12)}…\` into this thread.\n${meta}\nReply here to continue this session.${lockWarn}` });
  }

  // ── Quick aliases (e.g. !25-opus) → start a preset session ──
  const cmd0 = lower.split(/\s+/)[0];
  if (cmd0.startsWith('!') && QUICK_ALIASES[cmd0.slice(1)]) {
    const q = QUICK_ALIASES[cmd0.slice(1)];
    const prompt = text.split(/\s+/).slice(1).join(' ').trim();
    const rid = message.ts;
    return startSession({ threadKey: `${channel}:${rid}`, rootTs: rid, reactTs: rid, channel, patch: { cwd: q.cwd, model: q.model, agent: q.agent }, prompt, say, client });
  }

  // ── Inside a thread → continue / control that session ──
  if (isThreadReply) {
    if (!store.has(threadKey)) {
      return say({ thread_ts: rootTs, text: 'This thread has no session. Just send a new message at the top level to start one.' });
    }
    if (text.startsWith('!')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      switch (cmd.toLowerCase()) {
        case 'abort': {
          const c = running.get(threadKey);
          if (!c) return say({ thread_ts: rootTs, text: 'Nothing is running in this thread.' });
          // Immediately free the thread for new messages.
          running.delete(threadKey);
          aborted.add(threadKey);
          // Kill process group when available (Kiro uses detached groups), otherwise kill child.
          try { process.kill(-c.pid, 'SIGTERM'); } catch (_) { try { c.kill('SIGTERM'); } catch (_) {} }
          setTimeout(() => {
            try { process.kill(-c.pid, 'SIGKILL'); } catch (_) { try { c.kill('SIGKILL'); } catch (_) {} }
          }, 3000);
          return say({ thread_ts: rootTs, text: '🛑 Aborted. You can send a new message now.' });
        }
        case 'peek': {
          const live = livePeek(threadKey);
          return say({ thread_ts: rootTs, text: live || 'Nothing is running in this thread. Send a message to start.' });
        }
        case 'status': {
          const live = livePeek(threadKey);
          if (live) return say({ thread_ts: rootTs, text: live });
          const st = store.get(threadKey);
          let turns = '';
          if (st.sessionId) {
            try {
              const s = (await listSessionsFor(st)).find((x) => x.sessionId === st.sessionId);
              if (s) turns = `\n• turns: \`${s.messageCount}\``;
            } catch (e) { /* ignore */ }
          }
          return say({ thread_ts: rootTs, text: `*Session* (idle)\n• brain: \`${brainIdForState(st)}\`\n• dir: \`${st.cwd}\`\n• agent: \`${st.agent || '(default)'}\`\n• model: \`${st.model || '(default)'}\`\n• provider: \`${st.provider || '(default)'}\`\n• verbose: \`${st.verbose ? 'on' : 'off'}\`${turns}\n• sessionId: \`${st.sessionId || '(pending)'}\`` });
        }
        case 'model':
          if (!arg) return say({ thread_ts: rootTs, text: 'Usage: `!model <name>` (or `!model clear`)' });
          store.set(threadKey, { model: arg.toLowerCase() === 'clear' ? null : arg });
          return say({ thread_ts: rootTs, text: `🧠 Model → \`${arg.toLowerCase() === 'clear' ? '(default)' : arg}\` (applies to your next message).` });
        case 'provider':
          if (!arg) return say({ thread_ts: rootTs, text: 'Usage: `!provider <name>` (or `!provider clear`)' });
          store.set(threadKey, { provider: arg.toLowerCase() === 'clear' ? null : arg });
          return say({ thread_ts: rootTs, text: `🏷️ Provider → \`${arg.toLowerCase() === 'clear' ? '(default)' : arg}\` (applies to your next message).` });
        case 'agent':
          if (!arg) return say({ thread_ts: rootTs, text: 'Usage: `!agent <name>`' });
          store.set(threadKey, { agent: arg });
          return say({ thread_ts: rootTs, text: `👤 Agent → \`${arg}\` (applies to your next message).` });
        case 'end':
        case 'done':
          store.remove(threadKey);
          return say({ thread_ts: rootTs, text: '✅ Session closed. Start a new one any time with a top-level message.' });
        case 'clear':
        case 'reset':
          store.set(threadKey, { sessionId: null, announced: false });
          return say({ thread_ts: rootTs, text: '🧹 Cleared — your next message starts a fresh session in this thread.' });
        case 'verbose': {
          const cur = store.get(threadKey).verbose;
          const on = !arg ? !cur : /^(on|true|yes|1)$/i.test(arg);
          store.set(threadKey, { verbose: on });
          return say({ thread_ts: rootTs, text: on ? '🗣️ Verbose ON — full tool trace shown for this session.' : '🤫 Verbose OFF — answers only (default).' });
        }
        default:
          return say({ thread_ts: rootTs, text: 'In a thread: `!peek`, `!status`, `!abort`, `!model <name>`, `!provider <name>`, `!agent <name>`, `!verbose`, `!clear`, `!end`. Anything else is a prompt.' });
      }
    }
    return runTurn({ threadKey, thread_ts: rootTs, reactTs: message.ts, channel, prompt: text, say, client });
  }

  // ── Top-level → start a NEW session ──
  if (lower.startsWith('!new')) {
    const { patch, prompt } = parseNew(text);
    return startSession({ threadKey, rootTs: message.ts, reactTs: message.ts, channel, patch, prompt, say, client });
  }
  if (text.startsWith('!')) {
    if (['!status', '!abort', '!model', '!provider', '!agent', '!end', '!done'].includes(lower.split(/\s+/)[0])) {
      return say({ thread_ts: message.ts, text: 'That command works *inside a thread*. To start, just type your task.' });
    }
    return say({ thread_ts: message.ts, text: 'Unknown command. Just type a task to start a session, or `!help`.' });
  }
  // Plain natural-language message → route via broker (if on), else default session.
  if (BROKER_ON) {
    const rt = message.ts;
    const tkey = `${channel}:${rt}`;
    await say({ thread_ts: rt, text: ':compass: _routing your request…_' });
    let decision = null;
    try { decision = await route(text, brokerCtx(), BROKER_MODEL); }
    catch (e) { console.log('[broker error]', e.message); }
    if (decision && decision.cwd) {
      store.set(tkey, { brain: DEFAULT_BRAIN, cwd: decision.cwd, agent: decision.agent || DEFAULT_AGENT, model: decision.model || DEFAULT_MODEL, verbose: true, sessionId: null, announced: true });
      await say({ thread_ts: rt, text: `:compass: *${decision.note || 'Routed'}*\nbrain \`${DEFAULT_BRAIN}\` · dir \`${path.basename(decision.cwd)}\` · agent \`${decision.agent || DEFAULT_AGENT}\`${decision.model ? ` · model \`${decision.model}\`` : ''}` });
      if (decision.prompt) return runTurn({ threadKey: tkey, thread_ts: rt, reactTs: rt, channel, prompt: decision.prompt, say, client });
      return say({ thread_ts: rt, text: 'Reply in this thread to continue.' });
    }
    // broker failed → fall through to default
  }
  // Default: auto-start a new session (agent: main by default).
  return startSession({ threadKey, rootTs: message.ts, reactTs: message.ts, channel, patch: {}, prompt: text, say, client });
}

app.message(async (args) => {
  try {
    await handleMessage(args);
  } catch (e) {
    console.error('[handler error]', e);
    const { message, say } = args;
    try { await say({ thread_ts: message.thread_ts || message.ts, text: `⚠️ Something went wrong: ${e.message || e}` }); } catch (_) { /* ignore */ }
  }
});

(async () => {
  if (ALLOW_ALL) console.warn('⚠️  ALLOW-ALL mode: every user in this workspace can control AI CLIs on this machine.');
  await app.start();
  console.log('⚡ CLI Controller Slack bridge running (Socket Mode) — thread = session.');
  console.log('   Access:', ALLOW_ALL ? 'ALL users' : (ALLOWED.join(', ') || '(none)'));
  console.log('   Default brain:', DEFAULT_BRAIN, '| available:', brains.listBrains().join(', '));
  console.log('   Trust tools:', TRUST_TOOLS === 'ALL' ? 'ALL (full autonomy)' : (TRUST_TOOLS || '(none)'));
  console.log('   Default agent:', DEFAULT_AGENT, '| dir:', DEFAULT_CWD, '| timeout(ms):', TIMEOUT_MS || 'none');
  const aliases = Object.keys(DIR_ALIASES);
  if (aliases.length) console.log('   Dir aliases:', aliases.join(', '));
  console.log('   Broker:', BROKER_ON ? `on (${BROKER_MODEL})` : 'off');
  // Warm caches for the NL broker (best-effort, non-blocking).
  if (BROKER_ON) {
    const b = brainFor(DEFAULT_BRAIN);
    try { AGENTS_RAW = b.listAgents ? await b.listAgents(DEFAULT_CWD) : ''; } catch {}
    try { MODELS_CACHE = b.listModels ? await b.listModels() : []; } catch {}
  }
})();
