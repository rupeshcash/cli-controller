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
const { stripToolTrace, toSlack } = require('./format');

// ── Config ──────────────────────────────────────────────────────────────────
const RAW_ALLOWED = (process.env.SLACK_ALLOWED_USER_IDS || '').trim();
const ALLOW_ALL = RAW_ALLOWED === '*' || RAW_ALLOWED.toUpperCase() === 'ALL';
const ALLOWED = ALLOW_ALL ? [] : RAW_ALLOWED.split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_TOOLS = process.env.KIRO_TRUST_TOOLS ?? 'fs_read';
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
  const aliasNames = Object.keys(DIR_ALIASES);
  const workspaces = aliasNames.length
    ? aliasNames.map((a) => `   • \`${a}\` → \`${expandHome(DIR_ALIASES[a])}\``).join('\n')
    : '   _(none yet — set `KIRO_DIR_ALIASES` in .env)_';
  const ws = aliasNames.length ? aliasNames[0] : 'myrepo';
  return [
    ':robot_face: *Kiro Bridge* — drive Kiro from Slack',
    '',
    '*How it works*',
    '• Send *any message* → I start a session & reply in a :thread: *thread*',
    '• *Reply in the thread* → the same session continues',
    '• Each new top-level message → a separate, *parallel* session',
    '',
    '*Quick start*',
    '• `summarize the README here`   ← just type a task',
    '• `!new ' + ws + ' run the unit tests`   ← start in a saved workspace',
    '• `!new dir=~/path/to/repo fix the build`',
    '',
    `*Defaults*   agent \`${DEFAULT_AGENT}\` · dir \`${DEFAULT_CWD}\``,
    '*Workspaces*   (use as `!new <name> <task>` or `dir=<name>`)',
    workspaces,
    '',
    '*Override at start*',
    '`!new [agent=<name>] [dir=<path|workspace>] [model=<name>] <task>`',
    '',
    '*In a thread*   `!status` · `!abort` · `!model <name>` · `!agent <name>` · `!verbose` · `!clear` · `!end`',
    '',
    '_Replies are *verbose* by default (full tool trace). Add `-q` to `!new`, or `!verbose` in a thread, to toggle quiet mode (answer only)._',
    '*Anywhere*   `!help` · `!agents`',
    '',
    '*Status*   :hourglass_flowing_sand: working → :white_check_mark: done · :x: error',
  ].join('\n');
}

function parseNew(text) {
  let rest = text.slice(4).trim(); // after "!new"
  const patch = {};
  const optRe = /^(agent|dir|cwd|model|verbose)\s*=\s*(\S+)\s*/i;
  const flagVRe = /^(?:-v|--verbose)(?:\s+|$)/i;
  const flagQRe = /^(?:-q|--quiet)(?:\s+|$)/i;
  for (;;) {
    let m;
    if ((m = rest.match(optRe))) {
      const k = m[1].toLowerCase(); const v = m[2];
      if (k === 'agent') patch.agent = v;
      else if (k === 'dir' || k === 'cwd') patch.cwd = resolveDir(v);
      else if (k === 'model') patch.model = v;
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

// Send Kiro output to the thread: inline (chunked) if small, else as a file snippet.
async function sendOutput({ client, say, channel, thread_ts, text, verbose }) {
  const raw = text && text.trim() ? text : '(no output)';
  const shown = verbose ? raw : stripToolTrace(raw);
  const finalText = shown && shown.trim() ? shown : raw; // never send empty when there was output
  if (finalText.length <= SNIPPET_THRESHOLD) return sayThread(say, thread_ts, toSlack(finalText));
  try {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts,
      filename: 'kiro-response.md',
      title: 'Kiro output',
      initial_comment: `📄 Long output (${finalText.length.toLocaleString()} chars) — attached:`,
      content: finalText, // raw Markdown in the downloadable file
    });
  } catch (e) {
    await sayThread(say, thread_ts, toSlack(finalText)); // fallback to inline if upload fails
  }
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
  console.log(`[turn] ${threadKey} fresh=${isFresh} dir=${st.cwd} agent=${st.agent || 'default'} promptLen=${prompt.length}`);

  // Session header card — shown once per session (not repeated on the first prompt).
  if (isFresh && !st.announced) {
    await say({ thread_ts, text: `:thread: *New session* · dir \`${st.cwd}\` · agent \`${st.agent || 'default'}\`${st.model ? ` · model \`${st.model}\`` : ''}` });
    store.set(threadKey, { announced: true });
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
  console.log(`[turn done] ${threadKey} ok=${res.ok} code=${res.code} outLen=${(res.output || '').length} err=${(res.error || '').slice(0, 120)}`);

  if (!res.ok && !res.output) {
    return sayThread(say, thread_ts, `⚠️ ${res.error || `Kiro exited with code ${res.code}.`}`);
  }
  await sendOutput({ client, say, channel, thread_ts, text: res.output, verbose: st.verbose });
  if (!res.ok && res.error) await sayThread(say, thread_ts, `_error:_\n${res.error}`);
}

async function startSession({ threadKey, rootTs, reactTs, channel, patch, prompt, say, client }) {
  store.set(threadKey, {
    cwd: patch.cwd || DEFAULT_CWD,
    agent: patch.agent !== undefined ? patch.agent : DEFAULT_AGENT,
    model: patch.model !== undefined ? patch.model : DEFAULT_MODEL,
    verbose: patch.verbose !== undefined ? patch.verbose : true,
    sessionId: null,
  });
  if (prompt) return runTurn({ threadKey, thread_ts: rootTs, reactTs, channel, prompt, say, client });
  const s = store.get(threadKey);
  store.set(threadKey, { announced: true });
  return say({ thread_ts: rootTs, text: `:thread: *New session* · dir \`${s.cwd}\` · agent \`${s.agent || 'default'}\`\nReply in this thread to continue.` });
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
          let turns = '';
          if (st.sessionId) {
            try {
              const s = (await listSessions(st.cwd)).find((x) => x.sessionId === st.sessionId);
              if (s) turns = `\n• turns: \`${s.messageCount}\``;
            } catch (e) { /* ignore */ }
          }
          return say({ thread_ts: rootTs, text: `*Session*\n• dir: \`${st.cwd}\`\n• agent: \`${st.agent || '(default)'}\`\n• model: \`${st.model || '(default)'}\`\n• verbose: \`${st.verbose ? 'on' : 'off'}\`${turns}\n• sessionId: \`${st.sessionId || '(pending)'}\`` });
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
          return say({ thread_ts: rootTs, text: 'In a thread: `!status`, `!abort`, `!model <name>`, `!agent <name>`, `!verbose`, `!clear`, `!end`. Anything else is a prompt.' });
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
  if (ALLOW_ALL) console.warn('⚠️  ALLOW-ALL mode: every user in this workspace can control Kiro on this machine.');
  await app.start();
  console.log('⚡ Kiro Slack bridge running (Socket Mode) — thread = session.');
  console.log('   Access:', ALLOW_ALL ? 'ALL users' : (ALLOWED.join(', ') || '(none)'));
  console.log('   Trust tools:', TRUST_TOOLS === 'ALL' ? 'ALL (full autonomy)' : (TRUST_TOOLS || '(none)'));
  console.log('   Default agent:', DEFAULT_AGENT, '| dir:', DEFAULT_CWD, '| timeout(ms):', TIMEOUT_MS || 'none');
  const aliases = Object.keys(DIR_ALIASES);
  if (aliases.length) console.log('   Dir aliases:', aliases.join(', '));
})();
