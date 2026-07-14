const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/sessions');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clisess-'));
  return path.join(dir, 'state.json');
}

test('set() persists and a fresh store on the same file reloads it', () => {
  const f = tmpFile();
  const a = createStore(f);
  a.set('C1:100', { cwd: '/w/api', sessionId: 's1', agent: 'main' });
  const b = createStore(f);
  assert.equal(b.has('C1:100'), true);
  assert.equal(b.get('C1:100').sessionId, 's1');
  assert.equal(b.get('C1:100').cwd, '/w/api');
});

// PREVENTS: a crash mid-write truncating state.json and silently wiping every
// thread's session on the next boot ("This thread has no session" for all).
test('corrupt primary state.json recovers from the .bak snapshot', () => {
  const f = tmpFile();
  const a = createStore(f);
  a.set('C1:100', { sessionId: 's1' }); // first save (no prior → no .bak yet)
  a.set('C1:200', { sessionId: 's2' }); // second save snapshots the 1-entry state to .bak
  assert.ok(fs.existsSync(`${f}.bak`), '.bak snapshot exists after a second save');

  // Simulate a crash that left the primary file truncated/corrupt.
  fs.writeFileSync(f, '{ "C1:100": { "sessionId": "s1"');

  const b = createStore(f);
  // Recovered from .bak — at minimum the earlier thread survives (NOT a full wipe).
  assert.equal(b.has('C1:100'), true, 'thread survived the corruption via backup');
  assert.equal(b.get('C1:100').sessionId, 's1');
});

// PREVENTS: a corrupt file with no recoverable backup crashing the bridge.
test('corrupt primary with no usable backup resets to empty without throwing', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'not json at all');
  let store;
  assert.doesNotThrow(() => { store = createStore(f); });
  assert.equal(store.has('anything'), false);
});

// PREVENTS: readers ever seeing a partially written file (writes must be atomic).
test('no leftover .tmp file after a successful save', () => {
  const f = tmpFile();
  const a = createStore(f);
  a.set('C1:100', { sessionId: 's1' });
  assert.equal(fs.existsSync(`${f}.tmp`), false, 'temp file was renamed away, not left behind');
});

test('missing file (first run) starts empty and is still writable', () => {
  const f = tmpFile();
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const a = createStore(f); // file does not exist yet
  assert.equal(a.has('C1:1'), false);
  a.set('C1:1', { sessionId: 'x' });
  assert.equal(createStore(f).get('C1:1').sessionId, 'x');
});
