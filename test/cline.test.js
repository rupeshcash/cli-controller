const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonl, normalizeHistory, buildArgs } = require('../core/brain/cline');

test('parseJsonl extracts successful Cline run result', () => {
  const parsed = parseJsonl('{"type":"message","text":"partial"}\n{"type":"run_result","finishReason":"completed","text":"done","taskId":"abc123"}\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, 'done');
  assert.equal(parsed.sessionId, 'abc123');
});

test('parseJsonl reports Cline error events', () => {
  const parsed = parseJsonl('{"type":"error","message":"boom"}\n');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'boom');
});

test('buildArgs maps controller options to Cline CLI flags', () => {
  assert.deepEqual(
    buildArgs({ cwd: 'C:\\repo', sessionId: 'task-1', model: 'claude-sonnet', provider: 'anthropic', trustTools: 'ALL', timeoutMs: 90000 }),
    ['-c', 'C:\\repo', '--json', '--auto-approve', 'true', '--id', 'task-1', '-m', 'claude-sonnet', '-P', 'anthropic', '-t', '90'],
  );
});

test('normalizeHistory accepts array and object-shaped Cline history', () => {
  assert.deepEqual(normalizeHistory('[{"id":"a","title":"Alpha","workspace":"/tmp/a","updated_at":"2026"}]'), [
    { sessionId: 'a', title: 'Alpha', cwd: '/tmp/a', updatedAt: '2026' },
  ]);
  assert.deepEqual(normalizeHistory('{"sessions":[{"taskId":"b","summary":"Beta"}]}'), [
    { sessionId: 'b', title: 'Beta', cwd: null, updatedAt: null },
  ]);
});
