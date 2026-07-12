const test = require('node:test');
const assert = require('node:assert');
const brains = require('../../core/brain');

test('registry: kiro is registered', () => {
  assert.ok(brains.listBrains().includes('kiro'));
  assert.equal(brains.getBrain('kiro').id, 'kiro');
});

test('registry: unknown brain falls back to default (never undefined)', () => {
  const b = brains.getBrain('does-not-exist');
  assert.ok(b);
  assert.equal(b.id, brains.getBrain(undefined).id);
});

test('kiro adapter: capability shape + required methods', () => {
  const k = brains.getBrain('kiro');
  for (const cap of ['resume', 'agents', 'models', 'sessionStore', 'singleWriterLock', 'incrementalOutput']) {
    assert.equal(typeof k.capabilities[cap], 'boolean', `capability ${cap} is boolean`);
  }
  assert.equal(k.capabilities.singleWriterLock, true, 'kiro has a single-writer lock');
  for (const m of ['runTurn', 'listSessions', 'prepareResume', 'buildResumeCommand']) {
    assert.equal(typeof k[m], 'function', `has ${m}()`);
  }
});

test('kiro buildResumeCommand always includes --agent when present', () => {
  const cmd = brains.getBrain('kiro').buildResumeCommand({ id: 'abc', cwd: '/x', agent: 'main' });
  assert.match(cmd, /--agent main/);
  assert.match(cmd, /--resume-id abc/);
});
