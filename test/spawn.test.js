const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { candidatePaths, resolveCommand, spawnCli } = require('../core/spawn');

test('candidatePaths includes PATH candidates for bare commands', () => {
  const old = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-path-'));
  process.env.PATH = dir;
  try {
    const c = candidatePaths('cline');
    assert.ok(c.some((p) => p.includes(path.join(dir, 'cline'))));
  } finally { process.env.PATH = old; }
});

test('resolveCommand prefers an existing concrete binary', () => {
  const old = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-resolve-'));
  const file = path.join(dir, process.platform === 'win32' ? 'cline.cmd' : 'cline');
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  process.env.PATH = dir;
  try { assert.equal(resolveCommand('cline').toLowerCase(), file.toLowerCase()); }
  finally { process.env.PATH = old; }
});

test('spawnCli passes args through intact (prompt survives)', async () => {
  // node -e echoes its argv[1]; proves an arg with spaces reaches the child unmangled.
  const p = spawnCli(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'hey there world']);
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  await new Promise((r) => p.on('close', r));
  assert.equal(out, 'hey there world');
});

test('spawnCli falls back to homedir when cwd does not exist (stale/relocated session dir)', async () => {
  // PREVENTS: a stale session cwd crashing the spawn with a misleading ENOENT.
  const missing = path.join(os.tmpdir(), 'spawn-nope-' + Date.now(), 'deep', 'gone');
  const p = spawnCli(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: missing });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  await new Promise((r) => p.on('close', r));
  assert.equal(fs.realpathSync(out), fs.realpathSync(os.homedir()));
});
