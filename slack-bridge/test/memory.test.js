const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonMemory } = require('../../core/memory/json-store');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'climem-')); }

test('records a session + turn, get() reflects it, turns increment', () => {
  const m = new JsonMemory(tmp());
  m.recordSession({ sessionId: 's1', brain: 'kiro', cwd: '/w/api', title: 'fix sla' });
  m.recordTurn({ sessionId: 's1', prompt: 'fix the sla test', summary: 'patched SlaCalc', tags: ['sla'] });
  m.recordTurn({ sessionId: 's1', prompt: 'add a test', summary: 'added test' });
  const s = m.get('s1');
  assert.equal(s.brain, 'kiro');
  assert.equal(s.turns, 2);
  assert.ok(s.tags.includes('sla'));
  assert.equal(s.status, 'open');
});

test('turn on unknown session is ignored (no crash, no phantom record)', () => {
  const m = new JsonMemory(tmp());
  m.recordTurn({ sessionId: 'ghost', prompt: 'x' });
  assert.equal(m.get('ghost'), null);
});

test('search ranks a matching session above non-matching, respects filters', () => {
  const m = new JsonMemory(tmp());
  m.recordSession({ sessionId: 'a', brain: 'kiro', cwd: '/w/server', title: 'debug server correlation' });
  m.recordTurn({ sessionId: 'a', prompt: 'debug server', summary: 'looked at correlation heartbeat', tags: ['server'] });
  m.recordSession({ sessionId: 'b', brain: 'cline', cwd: '/w/blog', title: 'write a blog post' });
  m.recordTurn({ sessionId: 'b', prompt: 'blog', summary: 'drafted intro' });
  const hits = m.search('server correlation');
  assert.equal(hits[0].sessionId, 'a');
  assert.equal(m.search('server', { brain: 'cline' }).length, 0);
});

test('empty query falls back to recent (newest first) + cwd filter', () => {
  const m = new JsonMemory(tmp());
  m.recordSession({ sessionId: 'old', cwd: '/w/x' }); m.recordTurn({ sessionId: 'old', prompt: 'a' });
  m.recordSession({ sessionId: 'new', cwd: '/w/y' }); m.recordTurn({ sessionId: 'new', prompt: 'b' });
  assert.equal(m.recent({ limit: 1 })[0].sessionId, 'new');
  assert.equal(m.recent({ cwd: '/w/x' }).length, 1);
});

test('thread linkage resolves back to the session', () => {
  const m = new JsonMemory(tmp());
  m.recordSession({ sessionId: 's', brain: 'kiro', cwd: '/w' });
  m.linkThread('C1:123', 's');
  assert.equal(m.getByThread('C1:123').sessionId, 's');
  assert.equal(m.getByThread('nope'), null);
});

test('persistence: a fresh store on the same dir replays the log (never lost)', () => {
  const dir = tmp();
  const m1 = new JsonMemory(dir);
  m1.recordSession({ sessionId: 's', brain: 'kiro', cwd: '/w', title: 't' });
  m1.recordTurn({ sessionId: 's', prompt: 'p', summary: 'sum', tags: ['x'] });
  m1.recordDecision({ userText: 'do x', decision: { brain: 'kiro' }, outcome: 'ran' });
  const m2 = new JsonMemory(dir);
  assert.equal(m2.get('s').turns, 1);
  assert.equal(m2.get('s').summary, 'sum');
  assert.equal(m2.stats().decisions, 1);
});

test('endSession marks closed but keeps it searchable (never deleted)', () => {
  const m = new JsonMemory(tmp());
  m.recordSession({ sessionId: 's', cwd: '/w', title: 'auth middleware bug' });
  m.recordTurn({ sessionId: 's', prompt: 'auth', summary: 'fixed' });
  m.endSession('s');
  assert.equal(m.get('s').status, 'closed');
  assert.ok(m.search('auth middleware').some((h) => h.sessionId === 's'), 'closed session still found');
});

test('cross-process freshness: a second store sees the first store writes on read', () => {
  const dir = tmp();
  const a = new JsonMemory(dir);
  const b = new JsonMemory(dir); // simulates the web process; bridge = a
  a.recordSession({ sessionId: 's', cwd: '/w', title: 'shared write' });
  a.recordTurn({ sessionId: 's', prompt: 'hello', summary: 'hi' });
  assert.ok(b.search('shared write').some((h) => h.sessionId === 's'), 'b refreshes from shared log');
  assert.equal(b.get('s').turns, 1);
});

test('open sessions get a relevance boost over closed ones', () => {
  const m = new JsonMemory(tmp());
  m.recordSession({ sessionId: 'closed', cwd: '/w', title: 'payment refactor' }); m.recordTurn({ sessionId: 'closed', prompt: 'payment' }); m.endSession('closed');
  m.recordSession({ sessionId: 'open', cwd: '/w', title: 'payment refactor' }); m.recordTurn({ sessionId: 'open', prompt: 'payment' });
  assert.equal(m.search('payment refactor')[0].sessionId, 'open');
});
