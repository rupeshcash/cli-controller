#!/usr/bin/env node
// src/index.js — CLI Controller Slack bridge (Socket Mode). Model: THREAD = SESSION.
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
const { getBrain, listBrains, hasBrain, DEFAULT_BRAIN } = require('../../core/brain');
const { memory } = require('../../core/memory');
const { route, routeAdmin } = require('./broker');
const store = require('./sessions');
const { chunk } = require('./chunk');
const { stripToolTrace, toSlack } = require('./format');
const attach = require('./attachments');
const outfile = require('./outfile');

function rel(d) { if (!d) return '—'; const s = Math.floor((Date.now() - new Date(d)) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }

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

const { expandHome, resolveDir: _resolveDir, parseNew: _parseNew } = require('./parse');
function resolveDir(v) { return _resolveDir(DIR_ALIASES, v); }

// Natural-language routing broker (plain messages → decide dir/agent/model).
const BROKER_ON = process.env.KIRO_BROKER !== '0' && hasBrain('kiro'); // NL router runs on Kiro but can route to any brain (incl. Cline)
console.log(`[boot] brains=${listBrains().join(',')} · default=${DEFAULT_BRAIN} · env.CLI_CONTROLLER_DEFAULT_BRAIN=${process.env.CLI_CONTROLLER_DEFAULT_BRAIN || '(unset)'} · broker=${BROKER_ON ? 'on' : 'off'}`);
const BROKER_MODEL = process.env.KIRO_BROKER_MODEL || 'claude-haiku-4.5';
let AGENTS_RAW = '';
let MODELS_CACHE = [];
let BOT_USER_ID = null;   // resolved at startup via auth.test; used for channel @mention detection
function brokerCtx() {
  return { aliases: DIR_ALIASES, quick: QUICK_ALIASES, agentsRaw: AGENTS_RAW, models: MODELS_CACHE, defaultAgent: DEFAULT_AGENT, defaultCwd: DEFAULT_CWD, brains: listBrains(), defaultBrain: DEFAULT_BRAIN };
}

// Quick aliases: KIRO_QUICK_ALIASES="name:dir|model|agent, name2:dir|model"
// e.g. 25-opus:~/Documents/project-a|claude-opus-4.8|main
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
  // Some CLIs buffer output until the turn completes (not a TTY), so mid-run content
  // usually isn't available yet — report liveness instead.
  return `⏳ *CLI is still working — ${mins} elapsed.*\nOutput arrives when the turn completes. Send \`!abort\` to cancel.`;
}
// threadKeys whose current run was aborted — suppresses output from the dying process.
const aborted = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTok(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function usageLine(u, model) {
  if (!u) return 'no usage reported';
  const bits = [`${fmtTok(u.input)} in`, `${fmtTok(u.output)} out`];
  if (u.cost != null) bits.push(`$${Number(u.cost).toFixed(u.cost < 0.01 ? 4 : 2)}`);
  if (model) bits.push(String(model));
  return bits.join(' · ');
}
function usageFooter(u, model) { return `_⌁ ${usageLine(u, model)}_`; }

// Brain-aware control list: same verbs everywhere, but only show what THIS brain supports.
function brainControls(brainId) {
  const b = getBrain(brainId); const c = b.capabilities || {};
  const rows = ['`!model <name>` — choose the model'];
  if (brainId === 'cline') rows.push('`!provider <name>` — choose the provider');
  if (c.agents) rows.push('`!agent <name>` — choose the agent');
  if (c.planMode) rows.push('`!plan` / `!act` — plan-first vs act-directly');
  rows.push('`!usage` — tokens & cost of the last turn');
  return `━━ *This session — brain \`${b.displayName || brainId}\`* ━━\n${rows.map((r) => '• ' + r).join('\n')}`;
}

function helpText(brainId) {
  const aliasNames = Object.keys(DIR_ALIASES);
  const quickNames = Object.keys(QUICK_ALIASES);
  const ws = aliasNames.length ? aliasNames[0] : 'myrepo';
  const lines = [
    ':zap: *CLI Controller* — run AI coding CLIs from Slack. Each thread = one CLI session.',
    '',
    '━━ *How it works* ━━',
    '• *Send any message* → starts a new session; I reply in a :thread: *thread*.',
    '• *Reply inside that thread* → continues the same session (full context).',
    '• Each new top-level message → a separate, *parallel* session.',
    '• *Attach an image or text snippet* → forwarded to the agent (image-capable brains, e.g. Kiro, can see it).',
    `• Defaults: agent \`${DEFAULT_AGENT}\` · dir \`${DEFAULT_CWD}\` · verbose on.`,
    '',
    '━━ *Start a session* ━━',
    '• Just describe what you want, naturally — a router picks the repo/agent/model for you.',
    '   e.g. `in the 2025 api repo, use opus to fix the failing SLA test`',
    `• \`!new ${ws} run the unit tests\` — explicit workspace`,
    '• `!new brain=cline dir=~/path provider=anthropic model=claude-opus-4.8 <task>` — full control',
    '• `!new -q <task>` — quiet (answer only, no tool trace)',
  ];
  if (quickNames.length) lines.push(`• Quick starts: ${quickNames.map((a) => '`!' + a + '`').join(' · ')}`);
  if (aliasNames.length) lines.push(`• Workspaces: ${aliasNames.map((a) => '`' + a + '`').join(' · ')}`);
  lines.push(
    '',
    '━━ *Inside a thread: talk to your agent — or your controller* ━━',
    '• *Bare message* → goes to your *coding agent* (continues the session).',
    '• `!` + *anything* → talks to your *controller* (me), in plain language:',
    '   `!use cline` · `!switch to opus` · `!abort this` · `!start over` · `!be quiet` · `!fetch me the design.md for ENG-42`',
    '• Fast commands (instant): `!abort` `!status` `!peek` `!end` `!clear` `!verbose` `!model <n>` `!provider <n>` `!agent <n>` `!plan`/`!act` `!usage` `!file <path>`',
    '',
    '━━ *Find & resume any session* ━━',
    '• `!recent [n]` — recent sessions (terminal *and* Slack)  ·  `!teleport <id>` — pull one into a thread',
    '',
    '━━ *Info* ━━',
    '• `!agents` · `!models` · `!help`',
    '',
    '_Status reactions:_ :hourglass_flowing_sand: working → :white_check_mark: done · :x: error',
  );
  if (brainId) lines.push('', brainControls(brainId));
  return lines.filter((l) => l !== null).join('\n');
}

function parseNew(text) { return _parseNew(text, DIR_ALIASES); }

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
      filename: 'cli-response.md',
      title: 'CLI output',
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

// The session a fresh run created = the id present now but not before.
async function captureNewSession(brain, cwd, beforeIds) {
  const now = await brain.listSessions(cwd);
  const fresh = now.find((s) => !beforeIds.has(s.sessionId));
  // Only return a genuinely-new session. NEVER fall back to an existing one —
  // that would silently latch the thread onto an unrelated conversation.
  return (fresh && fresh.sessionId) || null;
}

// Copyable terminal-resume command for a session — built from the brain's OWN
// recipe (brain-agnostic: each adapter supplies buildResumeCommand). Kiro emits
// `cd <cwd> && kiro-cli chat --agent <a> --resume-id <id>`; Cline emits its own.
// Returns null if the brain doesn't expose one, so callers stay generic.
function resumeCommand(brain, st, sid) {
  if (!sid || !brain || typeof brain.buildResumeCommand !== 'function') return null;
  try { return brain.buildResumeCommand({ id: sid, sessionId: sid, cwd: st.cwd, agent: st.agent }) || null; }
  catch { return null; }
}
// One-time Slack block: "resume this session in your terminal" with a copyable command.
function terminalResumeLine(brain, st, sid) {
  const cmd = resumeCommand(brain, st, sid);
  if (!cmd) return null;
  return `:desktop_computer: *Resume in terminal* (session \`${String(sid).slice(0, 12)}…\`):\n\`\`\`\n${cmd}\n\`\`\``;
}

// Recent sessions across ALL brains (Kiro + Cline + …), newest first, tagged with brain.
async function allRecent(n) {
  const lists = await Promise.all(listBrains().map(async (b) => {
    try { return (await getBrain(b).recentSessions(n)).map((s) => ({ ...s, brain: b })); } catch { return []; }
  }));
  return lists.flat().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, n);
}

async function runTurn({ threadKey, thread_ts, reactTs, channel, prompt, say, client }) {
  if (running.has(threadKey)) {
    return say({ thread_ts, text: '⏳ Still working in this thread. Send `!abort` to cancel it first.' });
  }
  const st = store.get(threadKey);
  const isFresh = !st.sessionId;
  const brain = getBrain(st.brain);
  // Don't silently run a context-less turn against a session open in another LIVE process
  // (Kiro can't attach → reply would ignore this session's history). Tell the user to take over.
  if (!isFresh) {
    const chk = brain.prepareResume ? await brain.prepareResume(st.sessionId) : { action: 'ok' };
    if (chk.action === 'blocked') {
      return say({ thread_ts, text: `:warning: This session is open in another process (pid ${chk.pid}), so I can't continue it here — you'd get replies without this session's context.\n• Take it over: \`!teleport ${st.sessionId} force\` (terminates that process), then resend your message.\n• Or close it there first.` });
    }
  }
  console.log(`[turn] ${threadKey} brain=${brain.id} fresh=${isFresh} dir=${st.cwd} agent=${st.agent || 'default'} promptLen=${prompt.length}`);

  // Session header card — shown once per session (not repeated on the first prompt).
  if (isFresh && !st.announced) {
    await say({ thread_ts, text: `:thread: *New ${brain.displayName || brain.id || 'CLI'} session* · dir \`${st.cwd}\` · agent \`${st.agent || 'default'}\`${st.model ? ` · model \`${st.model}\`` : ''}${st.provider ? ` · provider \`${st.provider}\`` : ''}` });
    store.set(threadKey, { announced: true });
  }

  // Status via reaction; fall back to a text note if reactions aren't permitted.
  const reactedOk = await react(client, channel, reactTs, 'hourglass_flowing_sand');
  if (!reactedOk) await say({ thread_ts, text: `🤔 ${brain.displayName || brain.id || 'CLI'} is working…` });

  const beforeIds = isFresh ? new Set((await brain.listSessions(st.cwd)).map((s) => s.sessionId)) : new Set();

  const prog = { startedAt: Date.now(), buf: '' };
  progress.set(threadKey, prog);
  const onData = (c) => { prog.buf += c; if (prog.buf.length > 24000) prog.buf = prog.buf.slice(-24000); };

  let res = await brain.runTurn({
    cwd: st.cwd, sessionId: st.sessionId, agent: st.agent, model: st.model, provider: st.provider, plan: st.mode === 'plan',
    trustTools: TRUST_TOOLS, prompt, timeoutMs: TIMEOUT_MS, onSpawn: (c) => running.set(threadKey, c), onData,
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
    const before2 = new Set((await brain.listSessions(st.cwd)).map((s) => s.sessionId));
    res = await brain.runTurn({
      cwd: st.cwd, sessionId: null, agent: st.agent, model: st.model, provider: st.provider, plan: st.mode === 'plan',
      trustTools: TRUST_TOOLS, prompt, timeoutMs: TIMEOUT_MS, onSpawn: (c) => running.set(threadKey, c), onData,
    });
    running.delete(threadKey);
    const sid2 = res.sessionId || await captureNewSession(brain, st.cwd, before2);
    if (sid2) { store.set(threadKey, { sessionId: sid2 }); persistThreadLink(threadKey, sid2, prompt); const line = terminalResumeLine(brain, st, sid2); if (line) await say({ thread_ts, text: line }); }
  } else if (isFresh) {
    // Capture even on failure: a transient CLI backend error may still create the
    // session (with the user's message), so a retry can resume WITH context
    // instead of zoning out into a brand-new session.
    const sid = res.sessionId || await captureNewSession(brain, st.cwd, beforeIds);
    if (sid) { store.set(threadKey, { sessionId: sid }); persistThreadLink(threadKey, sid, prompt); const line = terminalResumeLine(brain, st, sid); if (line) await say({ thread_ts, text: line }); }
  }
  progress.delete(threadKey);

  // Finalize status reaction.
  if (reactedOk) {
    await unreact(client, channel, reactTs, 'hourglass_flowing_sand');
    await react(client, channel, reactTs, res.ok ? 'white_check_mark' : 'x');
  }
  console.log(`[turn done] ${threadKey} ok=${res.ok} code=${res.code} outLen=${(res.output || '').length} err=${(res.error || '').slice(0, 120)}`);

  // Controller memory: record this turn + link the Slack thread to the session (best-effort).
  try {
    const st2 = store.get(threadKey);
    if (st2 && st2.sessionId) {
      const mem = require('../../core/memory').memory();
      mem.recordSession({ sessionId: st2.sessionId, brain: st2.brain || DEFAULT_BRAIN, cwd: st2.cwd, agent: st2.agent, title: (prompt || '').slice(0, 70) });
      mem.recordTurn({ sessionId: st2.sessionId, prompt, summary: (res.output || res.error || '').slice(0, 240), tags: [st2.brain || DEFAULT_BRAIN, path.basename(st2.cwd || '')].filter(Boolean) });
      mem.linkThread(threadKey, st2.sessionId);
    }
  } catch { /* memory is best-effort */ }

  if (!res.ok && !res.output) {
    const st2 = store.get(threadKey);
    const hint = st2.sessionId
      ? `\n\n_This turn failed (often a transient ${brain.displayName || brain.id || 'CLI'} backend error). Just send your message again — the session is kept, so I retry with full context._`
      : '\n\n_This turn failed before a session was established. Send your message again to retry._';
    return sayThread(say, thread_ts, `⚠️ ${res.error || `${brain.displayName || brain.id || 'CLI'} exited with code ${res.code}.`}${hint}`);
  }
  await sendOutput({ client, say, channel, thread_ts, text: res.output, verbose: st.verbose });
  if (res.usage) { store.set(threadKey, { lastUsage: res.usage, lastModel: res.model }); await sayThread(say, thread_ts, usageFooter(res.usage, res.model)); }
  if (!res.ok && res.error) await sayThread(say, thread_ts, `_error:_\n${res.error}`);
}

async function startSession({ threadKey, rootTs, reactTs, channel, patch, prompt, say, client }) {
  store.set(threadKey, {
    cwd: patch.cwd || DEFAULT_CWD,
    agent: patch.agent !== undefined ? patch.agent : DEFAULT_AGENT,
    model: patch.model !== undefined ? patch.model : DEFAULT_MODEL,
    provider: patch.provider || null,
    brain: patch.brain || DEFAULT_BRAIN,
    verbose: patch.verbose !== undefined ? patch.verbose : true,
    sessionId: null,
  });
  if (prompt) return runTurn({ threadKey, thread_ts: rootTs, reactTs, channel, prompt, say, client });
  const s = store.get(threadKey);
  store.set(threadKey, { announced: true });
  return say({ thread_ts: rootTs, text: `:thread: *New session* · dir \`${s.cwd}\` · brain \`${s.brain || DEFAULT_BRAIN}\` · agent \`${s.agent || 'default'}\`${s.provider ? ` · provider \`${s.provider}\`` : ''}\nReply in this thread to continue. _(terminal-resume command posts once it starts; or \`!status\`)_` });
}

// Stop the running child for a thread (SIGTERM → SIGKILL after 3s). Returns true if something was killed.
function abortThread(threadKey) {
  const c = running.get(threadKey);
  if (!c) return false;
  running.delete(threadKey);
  aborted.add(threadKey);
  try { process.kill(-c.pid, 'SIGTERM'); } catch (_) { try { c.kill('SIGTERM'); } catch (_) {} }
  setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch (_) { try { c.kill('SIGKILL'); } catch (_) {} } }, 3000);
  return true;
}

// The CONTROLLER acting on "!<natural language>" inside a live thread: classify the
// intent (fast Kiro call) and take the administrative action. Falls back safely.
// ── Slack-coupling boundary for workspace files ────────────────────────────────
// These two functions are the ONLY Slack-aware file code. Everything else (find,
// guard, read, deliver-decision) lives in `src/outfile.js`, which has no Slack
// dependency. Keep it that way: new file logic goes in outfile.js; only the
// Slack transport + user-facing messages belong here.

// Deliver one workspace file into a thread as a native Slack upload. Shared by the
// `!file` fast command and the controller's natural-language `fetch` action.
async function sendWorkspaceFileToThread({ client, channel, thread_ts, cwd, relPath, say }) {
  const res = await outfile.deliverWorkspaceFile({
    cwd,
    relPath,
    // Inject the Slack transport; outfile.js stays free of any Slack dependency.
    upload: ({ filename, buf, size }) => client.files.uploadV2({
      channel_id: channel,
      thread_ts,
      filename,
      title: filename,
      initial_comment: `📄 \`${relPath}\` (${size.toLocaleString()} bytes) from \`${path.basename(cwd)}\`:`,
      file: buf,
    }),
  });
  if (!res.ok) await say({ thread_ts, text: `⚠️ ${res.error}` });
  return res;
}

// Controller `fetch` action: locate a file by natural-language query under the session
// workspace and deliver it. 0 matches → say so; 1 → send it; N → list candidates.
// Pure discovery lives in outfile.findWorkspaceFiles; this function is only the UX policy.
async function handleFetchAction({ query, cwd, thread_ts, channel, client, say, note = '' }) {
  const matches = outfile.findWorkspaceFiles(cwd, query);
  if (!matches.length) {
    return say({ thread_ts, text: `🔎 Couldn't find a file matching "${query}" under \`${path.basename(cwd)}\`. Try \`!file <exact/path>\`.` });
  }
  if (matches.length === 1) {
    await say({ thread_ts, text: `🔎 Found \`${matches[0]}\` — sending…${note}` });
    return sendWorkspaceFileToThread({ client, channel, thread_ts, cwd, relPath: matches[0], say });
  }
  const body = matches.slice(0, 10).map((m, i) => `*${i + 1}.* \`${m}\``).join('\n');
  return say({ thread_ts, text: `🔎 Found ${matches.length} matches for "${query}" — grab one with \`!file <path>\`:\n${body}` });
}

async function applyAdmin(text, { threadKey, rootTs, say, client, channel }) {
  let d = null;
  try { d = await routeAdmin(text.replace(/^!\s*/, ''), brokerCtx(), BROKER_MODEL); }
  catch (e) { console.log('[admin broker error]', e.message); }
  if (!d || !d.action || d.action === 'none') {
    return say({ thread_ts: rootTs, text: `🤷 Couldn't turn that into an action${d && d.note ? ` — ${d.note}` : ''}.\nTry \`!help\`, or send a bare message to talk to the agent.` });
  }
  const note = d.note ? `\n_${d.note}_` : '';
  switch (d.action) {
    case 'abort':
      return say({ thread_ts: rootTs, text: abortThread(threadKey) ? '🛑 Aborted. Send a new message any time.' : 'Nothing is running in this thread.' });
    case 'end':
      store.remove(threadKey);
      return say({ thread_ts: rootTs, text: '✅ Session closed.' });
    case 'clear':
      store.set(threadKey, { sessionId: null, announced: false });
      return say({ thread_ts: rootTs, text: '🧹 Cleared — your next message starts fresh in this thread.' });
    case 'status': {
      const live = livePeek(threadKey);
      return say({ thread_ts: rootTs, text: live || 'Idle. Send a message to continue this session.' });
    }
    case 'model': {
      const v = d.value && d.value.toLowerCase() !== 'clear' ? d.value : null;
      store.set(threadKey, { model: v });
      return say({ thread_ts: rootTs, text: `🧠 Model → \`${v || '(default)'}\` (next message).${note}` });
    }
    case 'agent':
      if (!d.value) return say({ thread_ts: rootTs, text: 'Which agent?' });
      store.set(threadKey, { agent: d.value });
      return say({ thread_ts: rootTs, text: `👤 Agent → \`${d.value}\` (next message).${note}` });
    case 'brain': {
      const b = (d.value || '').toLowerCase();
      if (!hasBrain(b)) return say({ thread_ts: rootTs, text: `Unknown brain \`${b}\`. Available: ${listBrains().join(', ')}.` });
      store.set(threadKey, { brain: b });
      return say({ thread_ts: rootTs, text: `🧩 Brain → \`${b}\` (next message).${note}` });
    }
    case 'verbose': {
      const on = /^(on|true|yes|1)$/i.test(d.value || 'on');
      store.set(threadKey, { verbose: on });
      return say({ thread_ts: rootTs, text: on ? '🗣️ Verbose ON.' : '🤫 Verbose OFF.' });
    }
    case 'recall': {
      const mem = require('../../core/memory').memory();
      const hits = mem.search(d.value || text.replace(/^!\s*/, ''), { limit: 6 });
      if (!hits.length) return say({ thread_ts: rootTs, text: `🔎 Nothing in memory matched "${d.value || ''}".` });
      const body = hits.map((s, i) => `*${i + 1}.* ${s.title || '(untitled)'} · \`${s.brain || '?'}\` · ${s.status}${s.cwd ? ` · \`${path.basename(s.cwd)}\`` : ''}\n   \`${s.sessionId}\``).join('\n');
      return say({ thread_ts: rootTs, text: `🔎 *Recall* — matches for "${d.value || ''}":\n${body}\n\n_Resume one:_ \`!teleport <id>\`` });
    }
    case 'recent': {
      const n = Math.min(parseInt(d.value, 10) || 8, 20);
      const items = await allRecent(n);
      if (!items.length) return say({ thread_ts: rootTs, text: 'No sessions found.' });
      const body = items.map((s, i) => `*${i + 1}.* ${s.locked ? ':lock: ' : ''}${s.title} · \`${s.brain}\`\n   \`${s.id}\``).join('\n');
      return say({ thread_ts: rootTs, text: `*Recent sessions* (all brains):\n${body}\n\n_Resume:_ \`!teleport <id> <brain>\`` });
    }
    case 'teleport':
      return say({ thread_ts: rootTs, text: d.value ? `To resume that session, send \`!teleport ${d.value}\` as a *top-level* message.` : 'Which session id? See `!recent`.' });
    case 'fetch': {
      const cwd = (store.get(threadKey) || {}).cwd || DEFAULT_CWD;
      const query = d.value || text.replace(/^!\s*/, '');
      return handleFetchAction({ query, cwd, thread_ts: rootTs, channel, client, say, note });
    }
    case 'help':
      return say({ thread_ts: rootTs, text: helpText() });
    default:
      return say({ thread_ts: rootTs, text: `🤷 Not supported yet.${note}` });
  }
}

// ── Message handling ────────────────────────────────────────────────────────
// Strong open-session matches from memory → offer resume-vs-new (conservative threshold).
const RESUME_MIN_SCORE = parseFloat(process.env.KIRO_RESUME_PROMPT_MIN_SCORE || '1.2');
function resumeCandidates(text) {
  if (process.env.KIRO_RESUME_PROMPTS === '0') return [];
  try { return memory().search(text, { limit: 3, status: 'open' }).filter((c) => c.score >= RESUME_MIN_SCORE); }
  catch { return []; }
}

// Route a fresh top-level message via the broker (NL), falling back to a default session.
async function brokerStart({ text, tkey, rt, channel, say, client }) {
  if (BROKER_ON) {
    await say({ thread_ts: rt, text: ':compass: _routing your request…_' });
    let decision = null;
    try { decision = await route(text, brokerCtx(), BROKER_MODEL); } catch (e) { console.log('[broker error]', e.message); }
    if (decision && decision.cwd) {
      store.set(tkey, { cwd: decision.cwd, agent: decision.agent || DEFAULT_AGENT, model: decision.model || DEFAULT_MODEL, brain: decision.brain || DEFAULT_BRAIN, verbose: true, sessionId: null, announced: true });
      try { memory().recordDecision({ userText: text, decision: { cwd: decision.cwd, brain: decision.brain || DEFAULT_BRAIN, agent: decision.agent, model: decision.model }, outcome: decision.prompt ? 'ran' : 'opened' }); } catch {}
      await say({ thread_ts: rt, text: `:compass: *${decision.note || 'Routed'}*\ndir \`${path.basename(decision.cwd)}\` · brain \`${decision.brain || DEFAULT_BRAIN}\` · agent \`${decision.agent || DEFAULT_AGENT}\`${decision.model ? ` · model \`${decision.model}\`` : ''}` });
      if (decision.prompt) return runTurn({ threadKey: tkey, thread_ts: rt, reactTs: rt, channel, prompt: decision.prompt, say, client });
      return say({ thread_ts: rt, text: 'Reply in this thread to continue. _(Once it starts I’ll post a copyable terminal-resume command — or run `!status` any time.)_' });
    }
  }
  return startSession({ threadKey: tkey, rootTs: rt, reactTs: rt, channel, patch: {}, prompt: text, say, client });
}

// Resolve a CONTROLLER_PENDING thread: user answered the resume-vs-new question.
async function resolvePending(st, text, { threadKey, rootTs, channel, say, client }) {
  const { candidates, text: origText } = st.pending;
  store.set(threadKey, { pending: undefined });
  const num = text.trim().match(/^(\d+)/);
  if (num) {
    const c = candidates[parseInt(num[1], 10) - 1];
    if (c) {
      store.set(threadKey, { cwd: c.cwd || DEFAULT_CWD, agent: c.agent || DEFAULT_AGENT, brain: c.brain || DEFAULT_BRAIN, model: DEFAULT_MODEL, sessionId: c.sessionId, announced: true });
      try { memory().linkThread(threadKey, c.sessionId); } catch {}
      const prep = await getBrain(c.brain || DEFAULT_BRAIN).prepareResume(c.sessionId);
      const pid = prep && prep.pid;
      const warn = pid ? `\n:warning: This session is open in another live process (pid ${pid}) — resuming from two places can conflict.` : '';
      return say({ thread_ts: rootTs, text: `:leftwards_arrow_with_hook: Resuming *${c.title || c.sessionId.slice(0, 12)}* · brain \`${c.brain || '?'}\`.${warn}\nReply here to continue.` });
    }
  }
  if (/^(new|fresh|start|none|no)\b/i.test(text.trim())) return brokerStart({ text: origText, tkey: threadKey, rt: rootTs, channel, say, client });
  // anything else → treat this reply itself as a fresh task
  return brokerStart({ text, tkey: threadKey, rt: rootTs, channel, say, client });
}

// Rehydrate a thread whose in-memory/state.json session was lost (e.g. bridge
// restarted, or state.json was wiped) from the durable append-only memory log,
// which records threadKey -> session via linkThread(). Returns the recovered
// session id, or null if the memory has never seen this thread.
function recoverThread(threadKey) {
  try {
    const rec = memory().getByThread(threadKey);
    if (rec && rec.sessionId) {
      store.set(threadKey, {
        cwd: rec.cwd || DEFAULT_CWD,
        agent: rec.agent || DEFAULT_AGENT,
        brain: rec.brain || DEFAULT_BRAIN,
        model: DEFAULT_MODEL,
        verbose: true,
        sessionId: rec.sessionId,
        announced: true,
      });
      return rec.sessionId;
    }
  } catch (_) { /* memory is best-effort */ }
  return null;
}

// Durably link a Slack thread to its session in the append-only memory log the
// INSTANT the session id is known — not just at end-of-turn. This is the source
// recoverThread() reads, so writing it early guarantees a thread stays
// recoverable even if the process dies mid-turn.
function persistThreadLink(threadKey, sessionId, prompt) {
  if (!sessionId) return;
  try {
    const s = store.get(threadKey);
    const mem = memory();
    mem.recordSession({ sessionId, brain: s.brain || DEFAULT_BRAIN, cwd: s.cwd, agent: s.agent, title: (prompt || '').slice(0, 70) });
    mem.linkThread(threadKey, sessionId);
  } catch (_) { /* memory is best-effort */ }
}

async function handleMessage({ message, say, client }) {
  // Let file uploads through (subtype 'file_share' carries message.files[]); still ignore
  // edits/joins/other subtypes and any bot messages (incl. our own).
  if (message.bot_id) return;
  if (message.subtype && message.subtype !== 'file_share') return;
  const chType = message.channel_type;
  const isDM = chType === 'im';
  const isChannel = chType === 'channel' || chType === 'group' || chType === 'mpim';
  if (!isDM && !isChannel) return;                       // ignore app_home etc.
  if (!ALLOW_ALL && !ALLOWED.includes(message.user)) return;  // who may trigger — enforced in channels too

  let text = (message.text || '').trim();
  // In a channel the bot is one participant among many: only act on an @mention
  // (to START a session) or a reply inside a thread it already owns (to CONTINUE).
  const mentioned = BOT_USER_ID ? text.includes(`<@${BOT_USER_ID}>`) : false;
  if (BOT_USER_ID) text = text.replace(new RegExp(`<@${BOT_USER_ID}>`, 'g'), '').trim();
  if (!text && !attach.hasFiles(message)) return;

  const channel = message.channel;
  const isThreadReply = !!message.thread_ts && message.thread_ts !== message.ts;
  const rootTs = message.thread_ts || message.ts;
  const threadKey = `${channel}:${rootTs}`;
  // A thread is "known" if we have live state OR the durable memory log has it
  // linked (survives a state.json wipe / bridge restart).
  function memoryKnowsThread(k) { try { return !!memory().getByThread(k); } catch { return false; } }
  const threadKnown = store.has(threadKey) || (isThreadReply && memoryKnowsThread(threadKey));
  if (isChannel && !mentioned && !(isThreadReply && threadKnown)) return; // ignore unrelated channel chatter

  // ── Attachments: images + text snippets → forwarded to the brain (and, as text, to the controller) ──
  // Image forwarding is gated on the target brain's `images` capability (Kiro: yes, Cline: not yet).
  // For a thread reply the brain is known; for a fresh top-level message it defaults to DEFAULT_BRAIN
  // (the router may re-route, but images are only meaningful for image-capable brains — Kiro is default).
  if (attach.hasFiles(message)) {
    const targetBrain = (isThreadReply && store.has(threadKey)) ? (store.get(threadKey).brain || DEFAULT_BRAIN) : DEFAULT_BRAIN;
    const canImages = (getBrain(targetBrain).capabilities || {}).images === true;
    const dl = await attach.downloadFiles(message, process.env.SLACK_BOT_TOKEN);
    const note = attach.describe(dl, { includeImages: canImages });
    if (note) await say({ thread_ts: rootTs, text: note });
    if (dl.images.length && !canImages) {
      await say({ thread_ts: rootTs, text: `ℹ️ Brain \`${targetBrain}\` can’t view images yet — forwarding your text only. Switch with \`!use kiro\`.` });
    }
    const ctx = attach.buildContext(dl, { includeImages: canImages });
    if (ctx) text = text ? `${text}\n\n${ctx}` : ctx;
    if (!text) return; // nothing usable came through (e.g. all downloads failed)
  }

  const lower = text.toLowerCase();

  // Global commands
  if (lower === '!help') return say({ thread_ts: rootTs, text: helpText(store.has(threadKey) ? (store.get(threadKey).brain || DEFAULT_BRAIN) : null) });
  if (lower === '!agents') {
    const st = store.has(threadKey) ? store.get(threadKey) : { cwd: DEFAULT_CWD, brain: DEFAULT_BRAIN };
    const brain = getBrain(st.brain);
    const cwd = st.cwd || DEFAULT_CWD;
    const list = await brain.listAgents(cwd);
    return say({ thread_ts: rootTs, text: list ? `*Agents* (in \`${cwd}\`):\n\`\`\`\n${list.slice(0, 3000)}\n\`\`\`` : 'Could not list agents.' });
  }
  if (lower === '!models') {
    const st = store.has(threadKey) ? store.get(threadKey) : { brain: DEFAULT_BRAIN };
    const brain = getBrain(st.brain);
    const models = await brain.listModels();
    return say({ thread_ts: rootTs, text: models.length ? `*Models:*\n${models.map((m) => `• \`${m}\``).join('\n')}\n\n_Set with_ \`!model <name>\`` : 'Could not list models.' });
  }
  if (lower.startsWith('!recent')) {
    const n = Math.min(parseInt(text.split(/\s+/)[1], 10) || 8, 20);
    const items = await allRecent(n);
    if (!items.length) return say({ thread_ts: rootTs, text: 'No sessions found.' });
    const body = items.map((s, i) => `*${i + 1}.* ${s.locked ? ':lock: ' : ''}${s.title}\n   \`${s.id}\` · brain \`${s.brain}\`\n   ${s.agent || '—'} · \`${s.cwd ? path.basename(s.cwd) : '~'}\` · ${rel(s.updatedAt)}`).join('\n\n');
    return say({ thread_ts: rootTs, text: `*Recent sessions* (${items.length}, all brains):\n\n${body}\n\n_Continue any here with_ \`!teleport <sessionId> <brain>\`  ·  :lock: = open elsewhere` });
  }
  if (lower.startsWith('!teleport')) {
    const parts = text.split(/\s+/).slice(1).filter(Boolean);
    const id = (parts[0] || '').trim();
    const force = parts.some((p) => /^(force|--force|-f)$/i.test(p));
    const brainArg = parts.slice(1).find((p) => hasBrain(p.toLowerCase()));
    const brainId = (brainArg || DEFAULT_BRAIN).toLowerCase();
    if (!id) return say({ thread_ts: rootTs, text: 'Usage: `!teleport <sessionId> [brain] [force]` — pull a session into this thread. Add `force` to take over one open in another process. See `!recent`.' });
    const brain = getBrain(brainId);
    const info = await brain.getSessionInfo(id);
    const prep = brain.prepareResume ? await brain.prepareResume(id) : { action: 'ok' };
    let lockPid = prep && prep.action === 'blocked' ? prep.pid : null;
    let takeoverNote = '';
    if (lockPid && force && brain.forceUnlock) {
      const r = brain.forceUnlock(id);
      takeoverNote = r && r.killed ? `\n\n:skull_and_crossbones: Terminated the process holding this session (pid ${r.killed}) — taken over here.` : '';
      lockPid = null;
    }
    store.set(threadKey, {
      cwd: (info && info.cwd) || DEFAULT_CWD,
      agent: (info && info.agent) || DEFAULT_AGENT,
      brain: brain.id || brainId,
      model: DEFAULT_MODEL,
      verbose: true,
      sessionId: id,
      announced: true,
    });
    const meta = info
      ? `${info.title ? `*${info.title.slice(0, 70)}*\n` : ''}dir \`${path.basename(info.cwd || '~')}\` · brain \`${brain.id || brainId}\` · agent \`${info.agent || 'main'}\``
      : '_(session file not found — using default dir; resume may start fresh)_';
    const lockWarn = lockPid
      ? `\n\n:warning: *This session is open in another process* (pid ${lockPid}) — likely a terminal/TUI. Continuing here at the same time gives stale, conflicting replies.\n   • To take over anyway, send \`!teleport ${id} force\` — that *terminates that process* (you'll lose any unsaved work there).`
      : '';
    return say({ thread_ts: rootTs, text: `🛸 *Teleported* \`${id.slice(0, 12)}…\` into this thread.\n${meta}\nReply here to continue this session.${takeoverNote}${lockWarn}` });
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
      // The thread's session was lost (bridge restart, or state.json was wiped).
      // Recover it from the durable memory log rather than dead-ending.
      const recoveredId = recoverThread(threadKey);
      if (recoveredId) {
        await say({ thread_ts: rootTs, text: `:leftwards_arrow_with_hook: Recovered this thread's session (\`${recoveredId.slice(0, 12)}…\`) from memory — continuing.` });
      } else {
        // Never seen this thread → don't abandon it. Treat the reply as a fresh
        // task IN this thread so the user keeps working here.
        await say({ thread_ts: rootTs, text: ":information_source: I lost this thread's session (the bridge likely restarted). Starting a fresh session here from your message." });
        return brokerStart({ text, tkey: threadKey, rt: rootTs, channel, say, client });
      }
    }
    const stCur = store.get(threadKey);
    // CONTROLLER_PENDING: the controller asked resume-vs-new; this reply is the answer.
    if (stCur.pending && !text.startsWith('!')) return resolvePending(stCur, text, { threadKey, rootTs, channel, say, client });
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
          // Kill process group (SIGTERM), escalate to SIGKILL after 3s.
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
              const s = (await getBrain(st.brain).listSessions(st.cwd)).find((x) => x.sessionId === st.sessionId);
              if (s) turns = `\n• turns: \`${s.messageCount}\``;
            } catch (e) { /* ignore */ }
          }
          const rcmd = resumeCommand(getBrain(st.brain), st, st.sessionId);
          const resumeSuffix = rcmd ? `\n• resume in terminal:\n\`\`\`\n${rcmd}\n\`\`\`` : '';
          return say({ thread_ts: rootTs, text: `*Session* (idle)\n• brain: \`${st.brain || DEFAULT_BRAIN}\`\n• dir: \`${st.cwd}\`\n• agent: \`${st.agent || '(default)'}\`\n• model: \`${st.model || '(default)'}\`\n• provider: \`${st.provider || '(default)'}\`\n• verbose: \`${st.verbose ? 'on' : 'off'}\`${turns}\n• sessionId: \`${st.sessionId || '(pending)'}\`${resumeSuffix}` });
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
        case 'plan':
        case 'act': {
          const cur = store.get(threadKey) || {};
          const b = getBrain(cur.brain || DEFAULT_BRAIN);
          if (!(b.capabilities && b.capabilities.planMode)) {
            return say({ thread_ts: rootTs, text: `Plan/act mode isn't available for \`${b.displayName || cur.brain || DEFAULT_BRAIN}\`.` });
          }
          const mode = cmd.toLowerCase();
          store.set(threadKey, { mode });
          return say({ thread_ts: rootTs, text: mode === 'plan'
            ? '🗺️ *Plan mode* ON — your next messages plan before acting. `!act` to switch back.'
            : '⚡ *Act mode* ON — your next messages act directly (default).' });
        }
        case 'usage': {
          const cur = store.get(threadKey) || {};
          if (!cur.lastUsage) return say({ thread_ts: rootTs, text: 'No usage recorded yet — run a turn first. (Some brains don’t report usage.)' });
          return say({ thread_ts: rootTs, text: `*Last turn* · ${usageLine(cur.lastUsage, cur.lastModel)}` });
        }
        case 'file':
        case 'cat':
        case 'get': {
          if (!arg) return say({ thread_ts: rootTs, text: 'Usage: `!file <path>` — sends a file from this session\'s workspace here (e.g. `!file src/foo.py`).' });
          const cwd = (store.get(threadKey) || {}).cwd || DEFAULT_CWD;
          await sendWorkspaceFileToThread({ client, channel, thread_ts: rootTs, cwd, relPath: arg, say });
          return;
        }
        default:
          // Not a fast command → the CONTROLLER interprets it as natural-language admin.
          return applyAdmin(text, { threadKey, rootTs, say, client, channel });
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
    return say({ thread_ts: message.ts, text: 'At the top level, just *type your task* to start — the controller routes it.\nInside a thread, `!<anything>` talks to me (your *controller*): `!abort`, `!use cline`, `!switch to opus`, `!recent`… · `!help`' });
  }
  // Plain natural-language top-level message → maybe offer resume, else route + start.
  const rt = message.ts;
  const tkey = `${channel}:${rt}`;
  const cands = resumeCandidates(text);
  if (cands.length) {
    store.set(tkey, { pending: { candidates: cands, text }, cwd: DEFAULT_CWD, verbose: true, announced: true });
    const list = cands.map((c, i) => `*${i + 1}.* ${c.title || '(untitled)'} · \`${c.brain || '?'}\`${c.cwd ? ` · \`${path.basename(c.cwd)}\`` : ''} · ${rel(c.updatedAt)}`).join('\n');
    return say({ thread_ts: rt, text: `:brain: This might relate to ${cands.length === 1 ? 'a session I remember' : 'sessions I remember'}:\n${list}\n\nReply with the *number* to resume, or *new* to start fresh.` });
  }
  return brokerStart({ text, tkey, rt, channel, say, client });
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

const cfg = require('./config');
(async () => {
  const checks = cfg.validate(process.env);
  if (checks.length) console.log('🔍 Config check:');
  const { errors } = cfg.report(checks);
  if (errors) { console.error(`\n✗ ${errors} config error(s) — cannot start. Fix the above and retry.`); process.exit(1); }
  await app.start();
  attach.sweepOld(); // best-effort: drop attachment downloads older than 24h
  try { const a = await app.client.auth.test(); BOT_USER_ID = a.user_id; console.log('   Bot user:', a.user_id, '| channels: @mention to start, reply to continue'); } catch (e) { console.warn('   ⚠ auth.test failed — channel @mention detection disabled:', e.message); }
  console.log('⚡ CLI Controller Slack bridge running (Socket Mode) — thread = session.');
  console.log('   Default brain:', DEFAULT_BRAIN, '| available:', listBrains().join(', '));
  console.log('   Access:', ALLOW_ALL ? 'ALL users' : (ALLOWED.join(', ') || '(none)'));
  console.log('   Trust tools:', TRUST_TOOLS === 'ALL' ? 'ALL (full autonomy)' : (TRUST_TOOLS || '(none)'));
  console.log('   Default agent:', DEFAULT_AGENT, '| dir:', DEFAULT_CWD, '| timeout(ms):', TIMEOUT_MS || 'none');
  const aliases = Object.keys(DIR_ALIASES);
  if (aliases.length) console.log('   Dir aliases:', aliases.join(', '));
  console.log('   Broker:', BROKER_ON ? `on (${BROKER_MODEL})` : 'off');
  // Warm caches for the NL broker (best-effort, non-blocking).
  if (BROKER_ON) {
    try { AGENTS_RAW = await getBrain(DEFAULT_BRAIN).listAgents(DEFAULT_CWD); } catch {}
    try { MODELS_CACHE = await getBrain(DEFAULT_BRAIN).listModels(); } catch {}
  }
})();
