// src/broker.js — natural-language router for the Slack→Kiro bridge.
//
// Given a plain message, a fast Kiro call decides WHERE to run (cwd), WHICH
// agent/model, and extracts the actual task — so you can just type naturally
// from your phone instead of `!new dir=… model=…`. Returns a decision or null
// (on any failure the caller falls back to a default session).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { runKiro, getLatestSessionId } = require('./kiro');
const { listBrains } = require('../../core/brain');

const BROKER_DIR = path.join(os.tmpdir(), 'kiro-broker');
try { fs.mkdirSync(BROKER_DIR, { recursive: true }); } catch {}

function buildPrompt(userText, ctx) {
  const lines = [
    'You are the ROUTER for a Slack→Kiro-CLI bridge. Decide how to launch a Kiro coding session for the user\'s request.',
    'Respond with ONLY a single minified JSON object and NOTHING else (no prose, no code fences).',
    '',
    'JSON shape: {"cwd": string, "agent": string, "model": string|null, "brain": string, "prompt": string, "note": string}',
    '- cwd: absolute directory to run in, chosen from the workspaces/presets below based on the request. If unclear, use the default.',
    `- agent: one of the agents below. Default "${ctx.defaultAgent}".`,
    '- model: a model from the list below, or null for default. Map casual hints: opus->claude-opus-4.8, sonnet->claude-sonnet-5, haiku->claude-haiku-4.5.',
    `- brain: which AI tool runs the session, one of [${(ctx.brains || ['kiro']).join(', ')}]. Default "${ctx.defaultBrain || 'kiro'}". Map hints: "cline"->cline, "kiro"->kiro. Only change it if the user names a tool.`,
    '- prompt: the concrete task to run NOW, with routing words removed. IMPORTANT:',
    '    * If the user is only asking to START / OPEN / SET UP a session (e.g. "start a session in X", "open kiro in Y", "I want to work on Z", "let\'s debug in server") WITHOUT a specific executable instruction, set prompt to "" — the user will send the real task/ticket as their next message.',
    '    * Only fill prompt when there is a specific, actionable task (e.g. "fix the failing SLA test", "summarize the README", "why is PR #123 failing").',
    '- note: one short sentence explaining the routing choice (shown to the user).',
    '',
    'Examples:',
    '  "start a session in server with agent main" -> {"cwd":"<server path>","agent":"main","model":null,"prompt":"","note":"Opened server — send your task next."}',
    '  "I need to debug an issue in server, start a session there" -> {"cwd":"<server path>","agent":"main","model":null,"prompt":"","note":"Opened server, ready for the issue details."}',
    '  "in 2025 api use opus to fix the failing sla test" -> {"cwd":"<2025 api>","agent":"main","model":"claude-opus-4.8","prompt":"fix the failing sla test","note":"Routed to 2025 api with opus."}',
    '',
    'Workspaces (alias -> path):',
    ...(Object.keys(ctx.aliases).length ? Object.entries(ctx.aliases).map(([k, v]) => `  ${k} -> ${v}`) : ['  (none)']),
    'Quick presets (name -> dir | model | agent):',
    ...(Object.keys(ctx.quick).length ? Object.entries(ctx.quick).map(([k, v]) => `  ${k} -> ${v.cwd} | ${v.model || 'default'} | ${v.agent}`) : ['  (none)']),
    `Default cwd: ${ctx.defaultCwd}`,
    'Available agents:',
    (ctx.agentsRaw || '(main, default)'),
    `Available models: ${(ctx.models || []).join(', ') || '(default)'}`,
    '',
    `User request: """${userText}"""`,
    '',
    'Return ONLY the JSON object.',
  ];
  return lines.join('\n');
}

function extractJson(s) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function route(userText, ctx, model) {
  let res;
  try {
    res = await runKiro({ cwd: BROKER_DIR, agent: null, model, trustTools: '', prompt: buildPrompt(userText, ctx), timeoutMs: 60000 });
  } catch (e) { return null; }
  // best-effort cleanup so router sessions don't clutter session lists
  try {
    const sid = await getLatestSessionId(BROKER_DIR);
    if (sid) spawn(process.env.KIRO_BIN || 'kiro-cli', ['chat', '--delete-session', sid], { cwd: BROKER_DIR, stdio: 'ignore' });
  } catch {}
  const j = extractJson(res && res.output);
  if (!j || !j.cwd) return null;
  return {
    cwd: String(j.cwd),
    agent: j.agent || ctx.defaultAgent,
    model: j.model || null,
    brain: (j.brain && (ctx.brains || []).includes(String(j.brain).toLowerCase())) ? String(j.brain).toLowerCase() : undefined,
    prompt: (j.prompt || '').trim(),
    note: (j.note || '').trim(),
  };
}

// ── Manager admin-intent classifier ─────────────────────────────────────────
// When a user addresses the MANAGER with "!<natural language>" (not a known fast
// command), classify it into one administrative action. This is the manager
// "snatching control" of a thread — NOT a task for the coding agent.
function buildAdminPrompt(userText, ctx) {
  return [
    'You are the MANAGER of a Slack↔coding-agent bridge. The user addressed YOU (prefix "!") to take an ADMINISTRATIVE action on their session — NOT to give the coding agent a task.',
    'Respond with ONLY one minified JSON object, no prose, no code fences.',
    'Shape: {"action": string, "value": string|null, "note": string}',
    'action ∈ (pick the single best fit):',
    '  "abort"    stop the currently running task',
    '  "end"      close/finish this session',
    '  "clear"    start a fresh session in the same thread',
    '  "status"   report session status / liveness',
    '  "model"    switch model; value=model name. Map: opus->claude-opus-4.8, sonnet->claude-sonnet-5, haiku->claude-haiku-4.5',
    '  "agent"    switch agent; value=agent name',
    `  "brain"    switch AI tool; value ∈ [${(ctx.brains || ['kiro']).join(', ')}]`,
    '  "verbose"  value="on" or "off"',
    '  "recall"   search PAST sessions/decisions from memory; value=the search query',
    '  "recent"   list recent sessions; value=count or null',
    '  "teleport" resume a specific session; value=sessionId',
    '  "help"     show help',
    '  "none"     not an admin action we support yet; put a short reason in note',
    `Available agents: ${ctx.agentsRaw || '(main, default)'}`,
    `Available models: ${(ctx.models || []).join(', ') || '(default)'}`,
    'note: one short sentence to show the user.',
    `User said (after the "!"): """${userText}"""`,
    'Return ONLY the JSON object.',
  ].join('\n');
}

async function routeAdmin(userText, ctx, model) {
  let res;
  try {
    res = await runKiro({ cwd: BROKER_DIR, agent: null, model, trustTools: '', prompt: buildAdminPrompt(userText, ctx), timeoutMs: 45000 });
  } catch (e) { return null; }
  try {
    const sid = await getLatestSessionId(BROKER_DIR);
    if (sid) spawn(process.env.KIRO_BIN || 'kiro-cli', ['chat', '--delete-session', sid], { cwd: BROKER_DIR, stdio: 'ignore' });
  } catch {}
  const j = extractJson(res && res.output);
  if (!j || !j.action) return null;
  return { action: String(j.action).toLowerCase(), value: j.value != null ? String(j.value).trim() : null, note: (j.note || '').trim() };
}

module.exports = { route, routeAdmin, BROKER_DIR };
