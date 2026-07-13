const test = require('node:test');
const assert = require('node:assert');
const { parseTeleport } = require('../src/parse');
const { forceUnlock } = require('../../core/brain/kiro');

test('parseTeleport extracts the id and the force flag', () => {
  assert.deepEqual(parseTeleport('!teleport abc-123'), { id: 'abc-123', force: false });
  assert.deepEqual(parseTeleport('!teleport abc-123 force'), { id: 'abc-123', force: true });
  assert.deepEqual(parseTeleport('!teleport abc-123 --force'), { id: 'abc-123', force: true });
  assert.deepEqual(parseTeleport('!teleport abc-123 -f'), { id: 'abc-123', force: true });
  assert.equal(parseTeleport('!teleport').id, '');
  assert.equal(parseTeleport('!teleport abc-123 continue').force, false); // only force keywords enable takeover
});

test('forceUnlock on an unknown/unlocked session returns killed:null and never throws', () => {
  const r = forceUnlock('nonexistent-session-' + Date.now());
  assert.equal(r.killed, null);
});
