const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lc = require('../lib/lifecycle');

function tmpd() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clilc-')); }

test('pidAlive: true for this process, false for a bogus pid', () => {
  assert.equal(lc.pidAlive(process.pid), true);
  assert.equal(lc.pidAlive(2147480000), false);
});

test('readPid: live pid returned; stale or absent → null', () => {
  const d = tmpd(); const f = path.join(d, 'p.pid');
  fs.writeFileSync(f, String(process.pid));
  assert.equal(lc.readPid(f), process.pid);
  fs.writeFileSync(f, '2147480000');
  assert.equal(lc.readPid(f), null);
  assert.equal(lc.readPid(path.join(d, 'none.pid')), null);
});

test('start → status running → stop → not running (cross-platform, pure Node)', () => {
  const d = tmpd();
  const svc = { name: 't', cwd: d, args: ['-e', 'setInterval(() => {}, 1000)'], pidFile: path.join(d, 't.pid'), logFile: path.join(d, 't.log'), env: {} };
  const s = lc.start(svc);
  assert.ok(s.pid, 'got a pid');
  assert.equal(lc.status(svc).running, true);
  assert.equal(lc.start(svc).already, true, 'second start is a no-op');
  assert.equal(lc.stop(svc).stopped, true);
  assert.equal(lc.status(svc).running, false);
});
