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

const BROKER_DIR = path.join(os.tmpdir(), 'kiro-broker');
try { fs.mkdirSync(BROKER_DIR, { recursive: true }); } catch {}

function buildPrompt(userText, ctx) {
  const lines = [
    'You are the ROUTER for a Slack→Kiro-CLI bridge. Decide how to launch a Kiro coding session for the user\'s request.',
    'Respond with ONLY a single minified JSON object and NOTHING else (no prose, no code fences).',
    '',
    'JSON shape: {"cwd": string, "agent": string, "model": string|null, "prompt": string, "note": string}',
    '- cwd: absolute directory to run in, chosen from the workspaces/presets below based on the request. If unclear, use the default.',
    `- agent: one of the agents below. Default "${ctx.defaultAgent}".`,
    '- model: a model from the list below, or null for default. Map casual hints: opus->claude-opus-4.8, sonnet->claude-sonnet-5, haiku->claude-haiku-4.5.',
    '- prompt: the ACTUAL task to send to Kiro, with routing words (directory/model/agent mentions) removed. If the message is only routing with no task, use "".',
    '- note: one short sentence explaining the routing choice (shown to the user).',
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
    prompt: (j.prompt || '').trim(),
    note: (j.note || '').trim(),
  };
}

module.exports = { route, BROKER_DIR };
