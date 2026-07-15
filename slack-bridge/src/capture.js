// src/capture.js — fresh-session attribution for headless brains.
//
// kiro-cli has no "create-with-id" flag, so a fresh session's id is discovered by
// diffing `--list-sessions` before/after the spawn. That is only safe when EXACTLY
// ONE new session appears in the cwd. Two things make that true and keep it honest:
//   1. captureNewSession — strict: attribute a session only on exactly-one-new,
//      validated as a UUID. Zero or many → return null (never guess), which is what
//      prevents one Slack thread from latching onto another thread's session.
//   2. withCwdLock — serialize the brief CREATION window per cwd so two bridge fresh
//      turns in the same dir can't race into "two new sessions" and both miss.
//   3. pollForNewSession — capture the id as soon as it appears (early in the turn),
//      so the lock is held for seconds, not for the whole (possibly long) turn.

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Return the id of the single session created since `beforeIds`, or null.
async function captureNewSession(brain, cwd, beforeIds) {
  const now = await brain.listSessions(cwd);
  const fresh = now.filter((s) => s && s.sessionId && !beforeIds.has(s.sessionId));
  if (fresh.length !== 1) {
    if (fresh.length > 1) {
      console.warn(`[capture] ${cwd}: ${fresh.length} new sessions appeared — refusing to guess which is ours (prevents cross-session contamination). Thread starts fresh on next reply.`);
    }
    return null;
  }
  const id = fresh[0].sessionId;
  if (!SESSION_ID_RE.test(id)) {
    console.warn(`[capture] ${cwd}: captured session id is not a UUID (${JSON.stringify(id)}) — ignoring.`);
    return null;
  }
  return id;
}

// Per-cwd async mutex (chained-promise). Serializes only what fn does.
const _locks = new Map(); // cwd -> tail promise
async function withCwdLock(cwd, fn) {
  const prev = _locks.get(cwd) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  _locks.set(cwd, mine);
  try {
    await prev.catch(() => {}); // wait our turn; ignore a prior holder's error
    return await fn();
  } finally {
    if (release) release();
    if (_locks.get(cwd) === mine) _locks.delete(cwd); // drop entry if nobody queued behind us
  }
}

// Poll for the new session until it appears, the turn ends, or we time out.
// `isDone` lets a fast turn stop the poll early; a final check runs after the loop.
async function pollForNewSession(brain, cwd, beforeIds, isDone, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sid = await captureNewSession(brain, cwd, beforeIds);
    if (sid) return sid;
    if (typeof isDone === 'function' && isDone()) break;
    await sleep(intervalMs);
  }
  return captureNewSession(brain, cwd, beforeIds);
}

module.exports = { captureNewSession, withCwdLock, pollForNewSession, SESSION_ID_RE };
