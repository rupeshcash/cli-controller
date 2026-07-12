const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { candidatePaths, resolveCommand, normalizeSpawn } = require('../core/spawn');

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

test('normalizeSpawn runs JS npm bins through node', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-js-')), 'cli.js');
  fs.writeFileSync(file, 'console.log("ok")');
  const n = normalizeSpawn(file, ['--version']);
  assert.equal(n.command, process.execPath);
  assert.deepEqual(n.args, [file, '--version']);
});