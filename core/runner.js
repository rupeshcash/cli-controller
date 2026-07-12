// core/runner.js — brain-agnostic one-shot turn runner (used by the web cockpit).
// No interface (Slack/web) specifics. Honors resume-lock + failure-safe capture.
const { getBrain } = require('./brain');

async function captureNew(brain, cwd, before) {
  const now = await brain.listSessions(cwd);
  const fresh = now.find((s) => !before.has(s.sessionId));
  return (fresh && fresh.sessionId) || null; // genuinely-new or null (never an unrelated one)
}

// Run one turn. Returns { ok, output, error, sessionId, brain } or { blocked: <prepareResume> }.
async function runTurn({ brain, cwd, agent, model, sessionId, prompt, trustTools, timeoutMs = 0, onData }) {
  const b = getBrain(brain);
  if (sessionId && b.prepareResume) {
    const plan = await b.prepareResume(sessionId);
    if (plan.action === 'blocked') return { blocked: plan, brain: b.id };
  }
  const before = sessionId ? null : new Set((await b.listSessions(cwd)).map((s) => s.sessionId));
  const res = await b.runTurn({ cwd, sessionId, agent, model, trustTools, prompt, timeoutMs, onData });
  let newId = sessionId;
  if (!sessionId) newId = res.sessionId || (await captureNew(b, cwd, before)); // failure-safe (§ architecture #7)
  rememberTurn({ sessionId: newId, brain: b.id, cwd, prompt, res }); // best-effort manager memory
  return { ok: res.ok, output: res.output, error: res.error, sessionId: newId, brain: b.id };
}

// Record a turn into the manager's persistent memory. Never throws.
function rememberTurn({ sessionId, brain, cwd, prompt, res }) {
  if (!sessionId) return;
  try {
    const mem = require('./memory').memory();
    mem.recordSession({ sessionId, brain, cwd, title: (prompt || '').slice(0, 70) });
    mem.recordTurn({ sessionId, prompt, summary: (res.output || res.error || '').slice(0, 240), tags: [brain, require('path').basename(cwd || '')].filter(Boolean) });
  } catch { /* memory is best-effort */ }
}

module.exports = { runTurn, captureNew };
