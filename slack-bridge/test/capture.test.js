// Tests for fresh-session capture: strict attribution + per-cwd serialization.
// These pin the fix for cross-session contamination (RCA: two Slack threads
// latching onto one Kiro session). PREVENTS: a fresh turn stealing another
// thread's session id when multiple sessions exist in the same cwd.
const test = require('node:test');
const assert = require('node:assert');
const { captureNewSession, withCwdLock, pollForNewSession } = require('../src/capture');

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

// A fake brain whose session list we control per cwd.
function fakeBrain(byCwd) {
  return { listSessions: async (cwd) => (byCwd[cwd] || []).map((sessionId) => ({ sessionId })) };
}

test('captureNewSession returns the id when exactly one new session appeared', async () => {
  const brain = fakeBrain({ '/x': [UUID_A, UUID_B] });
  const before = new Set([UUID_A]);
  assert.equal(await captureNewSession(brain, '/x', before), UUID_B);
});

test('captureNewSession returns null when no new session appeared', async () => {
  const brain = fakeBrain({ '/x': [UUID_A] });
  assert.equal(await captureNewSession(brain, '/x', new Set([UUID_A])), null);
});

test('captureNewSession refuses to guess when MORE THAN ONE new session appeared (contamination guard)', async () => {
  // Two new sessions in the same cwd (e.g. a second Slack thread or a terminal kiro).
  const brain = fakeBrain({ '/x': [UUID_A, UUID_B] });
  const before = new Set(); // both are "new"
  assert.equal(await captureNewSession(brain, '/x', before), null);
});

test('captureNewSession rejects a non-UUID token (the stray "the" bug)', async () => {
  const brain = fakeBrain({ '/x': ['the'] });
  assert.equal(await captureNewSession(brain, '/x', new Set()), null);
});

test('withCwdLock serializes work on the same cwd', async () => {
  const order = [];
  const slow = async (tag) => { order.push(`${tag}:start`); await new Promise((r) => setTimeout(r, 30)); order.push(`${tag}:end`); };
  await Promise.all([
    withCwdLock('/same', () => slow('A')),
    withCwdLock('/same', () => slow('B')),
  ]);
  // No interleaving: one fully completes before the other starts.
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end']);
});

test('withCwdLock allows different cwds to run in parallel', async () => {
  const order = [];
  const slow = async (tag) => { order.push(`${tag}:start`); await new Promise((r) => setTimeout(r, 30)); order.push(`${tag}:end`); };
  await Promise.all([
    withCwdLock('/a', () => slow('A')),
    withCwdLock('/b', () => slow('B')),
  ]);
  // Both start before either ends → they overlapped.
  assert.equal(order[0].endsWith(':start'), true);
  assert.equal(order[1].endsWith(':start'), true);
});

test('withCwdLock releases the lock even when fn throws', async () => {
  await assert.rejects(withCwdLock('/e', async () => { throw new Error('boom'); }));
  let ran = false;
  await withCwdLock('/e', async () => { ran = true; });
  assert.equal(ran, true);
});

test('pollForNewSession returns the id once it appears', async () => {
  let calls = 0;
  const brain = {
    listSessions: async () => { calls += 1; return calls >= 2 ? [{ sessionId: UUID_B }] : []; },
  };
  const sid = await pollForNewSession(brain, '/x', new Set(), () => false, { timeoutMs: 2000, intervalMs: 10 });
  assert.equal(sid, UUID_B);
});

test('pollForNewSession stops early when the turn is done and still does a final check', async () => {
  const brain = fakeBrain({ '/x': [UUID_A] }); // never produces a new one
  const before = new Set([UUID_A]);
  const sid = await pollForNewSession(brain, '/x', before, () => true, { timeoutMs: 2000, intervalMs: 10 });
  assert.equal(sid, null);
});
