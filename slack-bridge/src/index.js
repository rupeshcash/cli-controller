#!/usr/bin/env node
// src/index.js — Kiro Slack bridge (Socket Mode). Model: THREAD = SESSION.
//
//   • Send ANY message            → starts a new Kiro session; the bot replies in a thread.
//   • Reply inside that thread     → continues the same session (no command).
//   • Each top-level message       → an independent, parallel session (its own thread).
//   • Default agent: `main` (configurable). Reactions show status: ⏳ → ✅ / ❌.
//
require('dotenv').config();
const os = require('os');
const { App } = require('@slack/bolt');
const { runKiro, listSessions, listAgents } = require('./kiro');
const store = require('./sessions');
const { chunk } = require('./chunk');

// ── Config ──────────────────────────────────────────────────────────────────
const RAW_ALLOWED = (process.env.SLACK_ALLOWED_USER_IDS || '').trim();
const ALLOW_ALL = RAW_ALLOWED === '*' || RAW_ALLOWED.toUpperCase() === 'ALL';
const ALLOWED = ALLOW_ALL ? [] : RAW_ALLOWED.split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_TOOLS = process.env.KIRO_TRUST_TOOLS ?? 'fs_read';
const DEFAULT_CWD = process.env.KIRO_DEFAULT_CWD || process.cwd();
const DEFAULT_AGENT = process.env.KIRO_AGENT || 'main';
const DEFAULT_MODEL = process.env.KIRO_MODEL || null;
const TIMEOUT_MS = Number.isFinite(parseInt(process.env.KIRO_TIMEOUT_MS, 10))
  ? parseInt(process.env.KIRO_TIMEOUT_MS, 10) : 300000; // 0 = no timeout

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function helpText() {
  const aliasList = Object.keys(DIR_ALIASES);
  return [
    '*Kiro Bridge — just chat* :speech_balloon:',
    '• *Send any message* → new session; I reply in a *thread*.',
    '• *Reply in that thread* → continues the same session.',
    '• Each new top-level message = a separate, parallel session.',
    '• Status shows as reactions: :hourglass_flowing_sand: working → :white_check_mark: done / :x: error.',
    '',
    `*Default agent:* \`${DEFAULT_AGENT}\`  ·  *Default dir:* \`${DEFAULT_CWD}\``,
    '*Override at start:* `!new [agent=<name>] [dir=<path|alias>] [model=<name>] <task>`',
    aliasList.length ? `*Dir aliases:* ${aliasList.map((a) => `\`${a}\``).join(', ')} — e.g. \`!new ${aliasList[0]} <task>\`` : '',
    '',
    '*Anywhere:* `!help`, `!agents`',
    '*In a thread:* `!status`, `!abort`, `!model <name>`, `!agent <name>`, `!end`',
  ].filter(Boolean).join('\n');
}

function parseNew(text) {
  const rest = text.slice(4).trim(); // after "!new"
  const toks = rest.length ? rest.split(/\s+/) : [];
  const patch = {};
  let i = 0;
  // key=value options
  for (; i < toks.length; i++) {
    const m = toks[i].match(/^(agent|dir|cwd|model)=(.+)$/i);
    if (!m) break;
    const k = m[1].toLowerCase();
    if (k === 'agent') patch.agent = m[2];
    else if (k === 'dir' || k === 'cwd') patch.cwd = resolveDir(m[2]);
    else if (k === 'model') patch.model = m[2];
  }
  // bare directory alias as first positional (e.g. "!new api <task>")
  if (patch.cwd === undefined && toks[i] && DIR_ALIASES[toks[i]]) {
    patch.cwd = resolveDir(toks[i]);
    i += 1;
  }
  return { patch, prompt: toks.slice(i).join(' ').trim() };
}

async function sayThread(say, thread_ts, text) {
  for (const part of chunk(text)) await say({ thread_ts, text: part });
}

// Reactions (graceful: no-op if the reactions:write scope isn't granted).
async function react(client, channel, ts, name) {
  try { await client.reactions.add({ channel, timestamp: ts, name }); return true; }
  catch (e) { return false; }
}
async function unreact(client, channel, ts, name) {
  try { await client.reactions.remove({ channel, timestamp: ts, name }); } catch (e) { /* ignore */ }
}

// The session a fresh run created = the id present now but not before.
async function captureNewSession(cwd, beforeIds) {
  const now = await listSessions(cwd);
  const fresh = now.find((s) => !beforeIds.has(s.sessionId));
  return (fresh && fresh.sessionId) || (now[0] && now[0].sessionId) || null;
}

async function runTurn({ threadKey, thread_ts, reactTs, channel, prompt, say, client }) {
  if (running.has(threadKey)) {
    return say({ thread_ts, text: '⏳ Still working in this thread. Send `!abort` to cancel it first.' });
  }
  const st = store.get(threadKey);
  const isFresh = !st.sessionId;

  // Session header card (first turn only) — gives the thread instant context.
  if (isFresh) {
    await say({ thread_ts, text: `:thread: *New session* · dir \`${st.cwd}\` · agent \`${st.agent || 'default'}\`${st.model ? ` · model \`${st.model}\`` : ''}` });
  }

  // Status via reaction; fall back to a text note if reactions aren't permitted.
  const reactedOk = await react(client, channel, reactTs, 'hourglass_flowing_sand');
  if (!reactedOk) await say({ thread_ts, text: '🤔 Kiro is working…' });

  const beforeIds = isFresh ? new Set((await listSessions(st.cwd)).map((s) => s.sessionId)) : new Set();

  let res = await runKiro({
    cwd: st.cwd, sessionId: st.sessionId, agent: st.agent, model: st.model,
    trustTools: TRUST_TOOLS, prompt, timeoutMs: TIMEOUT_MS, onSpawn: (c) => running.set(threadKey, c),
  });
  running.delete(threadKey);

  // Resume-failure fallback: stale session id → start fresh once.
  if (!res.ok && !isFresh && /session|not found|no conversation|resume/i.test(res.error || '')) {
    await say({ thread_ts, text: '↻ Couldn’t resume the previous session — starting a fresh one for this thread.' });
    const before2 = new Set((await listSessions(st.cwd)).map((s) => s.sessionId));
    res = await runKiro({
      cwd: st.cwd, sessionId: null, agent: st.agent, model: st.model,
      trustTools: TRUST_TOOLS, prompt, timeoutMs: TIMEOUT_MS, onSpawn: (c) => running.set(threadKey, c),
    });
    running.delete(threadKey);
    if (res.ok) { const sid = await captureNewSession(st.cwd, before2); if (sid) store.set(threadKey, { sessionId: sid }); }
  } else if (isFresh && res.ok) {
    const sid = await captureNewSession(st.cwd, beforeIds);
    if (sid) store.set(threadKey, { sessionId: sid });
  }

  // Finalize status reaction.
  if (reactedOk) {
    await unreact(client, channel, reactTs, 'hourglass_flowing_sand');
    await react(client, channel, reactTs, res.ok ? 'white_check_mark' : 'x');
  }

  if (!res.ok && !res.output) {
    return sayThread(say, thread_ts, `⚠️ ${res.error || `Kiro exited with code ${res.code}.`}`);
  }
  await sayThread(say, thread_ts, res.output || '(no output)');
  if (!res.ok && res.error) await sayThread(say, thread_ts, `_error:_\n${res.error}`);
}

async function startSession({ threadKey, rootTs, reactTs, channel, patch, prompt, say, client }) {
  store.set(threadKey, {
    cwd: patch.cwd || DEFAULT_CWD,
    agent: patch.agent !== undefined ? patch.agent : DEFAULT_AGENT,
    model: patch.model !== undefined ? patch.model : DEFAULT_MODEL,
    sessionId: null,
  });
  if (prompt) return runTurn({ threadKey, thread_ts: rootTs, reactTs, channel, prompt, say, client });
  const s = store.get(threadKey);
  return say({ thread_ts: rootTs, text: `:thread: *New session* · dir \`${s.cwd}\` · agent \`${s.agent || 'default'}\`\nReply in this thread to continue.` });
}

// ── Message handling ────────────────────────────────────────────────────────
app.message(async ({ message, say, client }) => {
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
    const list = await listAgents(cwd);
    return say({ thread_ts: rootTs, text: list ? `*Agents* (in \`${cwd}\`):\n\`\`\`\n${list.slice(0, 3000)}\n\`\`\`` : 'Could not list agents.' });
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
          if (c) { c.kill('SIGTERM'); return say({ thread_ts: rootTs, text: '🛑 Aborting…' }); }
          return say({ thread_ts: rootTs, text: 'Nothing is running in this thread.' });
        }
        case 'status': {
          const st = store.get(threadKey);
          return say({ thread_ts: rootTs, text: `*Session*\n• dir: \`${st.cwd}\`\n• agent: \`${st.agent || '(default)'}\`\n• model: \`${st.model || '(default)'}\`\n• sessionId: \`${st.sessionId || '(pending)'}\`` });
        }
        case 'model':
          if (!arg) return say({ thread_ts: rootTs, text: 'Usage: `!model <name>` (or `!model clear`)' });
          store.set(threadKey, { model: arg.toLowerCase() === 'clear' ? null : arg });
          return say({ thread_ts: rootTs, text: `🧠 Model → \`${arg.toLowerCase() === 'clear' ? '(default)' : arg}\` (applies to your next message).` });
        case 'agent':
          if (!arg) return say({ thread_ts: rootTs, text: 'Usage: `!agent <name>`' });
          store.set(threadKey, { agent: arg });
          return say({ thread_ts: rootTs, text: `👤 Agent → \`${arg}\` (applies to your next message).` });
        case 'end':
        case 'done':
          store.remove(threadKey);
          return say({ thread_ts: rootTs, text: '✅ Session closed. Start a new one any time with a top-level message.' });
        default:
          return say({ thread_ts: rootTs, text: 'In a thread: `!status`, `!abort`, `!model <name>`, `!agent <name>`, `!end`. Anything else is a prompt.' });
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
    if (['!status', '!abort', '!model', '!agent', '!end', '!done'].includes(lower.split(/\s+/)[0])) {
      return say({ thread_ts: message.ts, text: 'That command works *inside a thread*. To start, just type your task.' });
    }
    return say({ thread_ts: message.ts, text: 'Unknown command. Just type a task to start a session, or `!help`.' });
  }
  // Plain message → auto-start a new session (agent: main by default).
  return startSession({ threadKey, rootTs: message.ts, reactTs: message.ts, channel, patch: {}, prompt: text, say, client });
});

(async () => {
  if (ALLOW_ALL) console.warn('⚠️  ALLOW-ALL mode: every user in this workspace can control Kiro on this machine.');
  await app.start();
  console.log('⚡ Kiro Slack bridge running (Socket Mode) — thread = session.');
  console.log('   Access:', ALLOW_ALL ? 'ALL users' : (ALLOWED.join(', ') || '(none)'));
  console.log('   Trust tools:', TRUST_TOOLS === 'ALL' ? 'ALL (full autonomy)' : (TRUST_TOOLS || '(none)'));
  console.log('   Default agent:', DEFAULT_AGENT, '| dir:', DEFAULT_CWD, '| timeout(ms):', TIMEOUT_MS || 'none');
  const aliases = Object.keys(DIR_ALIASES);
  if (aliases.length) console.log('   Dir aliases:', aliases.join(', '));
})();
