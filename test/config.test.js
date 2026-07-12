const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../lib/config');

function tmpd() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clicfg-')); }

test('config roundtrip + isConfigured', () => {
  const d = tmpd();
  assert.equal(cfg.isConfigured(d), false);
  cfg.writeConfig({ version: 1, defaultBrain: 'cline', workspaces: { api: { path: '/w/api' } } }, d);
  assert.equal(cfg.isConfigured(d), true);
  const r = cfg.readConfig(d);
  assert.equal(r.defaultBrain, 'cline');
  assert.equal(r.workspaces.api.path, '/w/api');
});

test('readConfig returns a sane default when missing', () => {
  assert.equal(cfg.readConfig(tmpd()).defaultBrain, 'kiro');
});

test('writeEnv merges keys (preserving existing) and sets 0600', () => {
  const d = tmpd(); const f = path.join(d, '.env');
  cfg.writeEnv(f, { A: '1', B: '2' });
  cfg.writeEnv(f, { B: '3', C: '4' });
  const body = fs.readFileSync(f, 'utf8');
  assert.match(body, /A=1/);
  assert.match(body, /B=3/);
  assert.match(body, /C=4/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
