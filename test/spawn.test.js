const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveCommand, resolveSpawn, candidatePaths, npmBinScript } = require('../core/spawn');

test('candidatePaths includes Windows npm cmd shim variants for bare commands', { skip: process.platform !== 'win32' }, () => {
  const candidates = candidatePaths('cline').map((p) => path.basename(p).toLowerCase());
  assert.ok(candidates.includes('cline.cmd'));
});

test('resolveCommand prefers a concrete Windows cmd shim over a bare command', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-controller-spawn-'));
  const oldPath = process.env.PATH;
  try {
    const shim = path.join(dir, 'fake-cli.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho ok\r\n');
    process.env.PATH = dir + path.delimiter + oldPath;
    assert.equal(resolveCommand('fake-cli'), shim);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSpawn runs Windows npm package bins through node', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-controller-spawn-'));
  const pkgDir = path.join(dir, 'node_modules', 'fake-cli');
  const oldPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    const script = path.join(pkgDir, 'bin', 'fake-cli.js');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-cli', bin: { 'fake-cli': './bin/fake-cli.js' } }));
    fs.writeFileSync(script, 'console.log("ok")\n');
    process.env.PATH = dir + path.delimiter + oldPath;
    assert.equal(npmBinScript('fake-cli'), script);
    assert.deepEqual(resolveSpawn('fake-cli', ['--version']), {
      command: process.execPath,
      args: [script, '--version'],
      displayCommand: 'fake-cli',
      resolvedCommand: script,
    });
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCommand leaves unresolved commands unchanged', () => {
  assert.equal(resolveCommand('__definitely_missing_cli_controller_test__'), '__definitely_missing_cli_controller_test__');
});
