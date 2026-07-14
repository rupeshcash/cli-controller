const test = require('node:test');
const assert = require('node:assert');
const { parseJsonl, normalizeHistory, buildArgs, adapter, capabilities } = require('../../core/brain/cline');
const brains = require('../../core/brain');
const { parseNew } = require('../src/parse');

test('cline: registered in the brain registry', () => {
  assert.ok(brains.listBrains().includes('cline'));
  assert.equal(brains.getBrain('cline').id, 'cline');
});

test('cline capabilities: resume/models yes, no lock, streaming, no named agents', () => {
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.models, true);
  assert.equal(capabilities.agents, false);
  assert.equal(capabilities.singleWriterLock, false);
  assert.equal(capabilities.incrementalOutput, true);
});

test('cline parseJsonl: success run_result → ok + text + sessionId', () => {
  const jsonl = [
    '{"type":"hook_event","hookEventName":"agent_start","taskId":"conv_123"}',
    '{"type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
    '{"type":"run_result","finishReason":"complete","text":"done: added tests","taskId":"conv_123","model":{"id":"m"}}',
  ].join('\n');
  const r = parseJsonl(jsonl);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'done: added tests');
  assert.equal(r.sessionId, 'conv_123');
});

test('cline parseJsonl: error run_result → not ok + error message', () => {
  const jsonl = [
    '{"type":"run_result","finishReason":"error","text":"unable to get local issuer certificate","taskId":"conv_9"}',
    '{"type":"error","message":"unable to get local issuer certificate"}',
  ].join('\n');
  const r = parseJsonl(jsonl);
  assert.equal(r.ok, false);
  assert.match(r.error, /issuer certificate/);
});

test('cline buildArgs maps controller options to CLI flags', () => {
  assert.deepEqual(
    buildArgs({ cwd: 'C:\\repo', sessionId: 'task-1', model: 'claude-sonnet', provider: 'anthropic', trustTools: 'ALL', timeoutMs: 90000 }),
    ['-c', 'C:\\repo', '--json', '--auto-approve', 'true', '--id', 'task-1', '-m', 'claude-sonnet', '-P', 'anthropic', '-t', '90'],
  );
});

test('cline normalizeHistory accepts array and object-shaped history', () => {
  assert.deepEqual(normalizeHistory('[{"id":"a","title":"Alpha","workspace":"/tmp/a","updated_at":"2026"}]'), [
    { sessionId: 'a', title: 'Alpha', cwd: '/tmp/a', updatedAt: '2026' },
  ]);
  assert.deepEqual(normalizeHistory('{"sessions":[{"taskId":"b","summary":"Beta"}]}'), [
    { sessionId: 'b', title: 'Beta', cwd: null, updatedAt: null },
  ]);
});

test('cline prepareResume never blocks (no single-writer lock)', async () => {
  assert.deepEqual(await adapter.prepareResume('anything'), { action: 'ok' });
});

test('parseNew: brain=cline is parsed', () => {
  const { patch, prompt } = parseNew('!new brain=cline provider=anthropic dir=api do it', { api: '/p' });
  assert.equal(patch.brain, 'cline');
  assert.equal(patch.provider, 'anthropic');
  assert.equal(patch.cwd, '/p');
  assert.equal(prompt, 'do it');
});
