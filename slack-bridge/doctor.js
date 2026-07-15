#!/usr/bin/env node
// doctor.js — cross-platform diagnostics for the Kiro Slack bridge.
// Run: `node doctor.js`  or  `./bridge doctor`  or  `npm run doctor`.
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawnSync } = require('child_process');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}
const cfg = require('./src/config');

const ok = (m) => console.log('   ✓ ' + m);
const warn = (m) => console.warn('   ⚠ ' + m);
const bad = (m) => console.error('   ✗ ' + m);
const note = (m) => console.log('   · ' + m);
let errors = 0, warns = 0;
const mark = (c) => { if (c.level === 'error') { errors++; bad(c.msg); } else if (c.level === 'warn') { warns++; warn(c.msg); } else ok(c.msg); };

function nodeCheck() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  mark({ level: major >= 18 ? 'ok' : 'warn', msg: `Node ${process.versions.node}${major >= 18 ? '' : ' (recommend ≥ 18)'}` });
}

function brainCheck(label, envVar, defaultBin, hint) {
  const bin = process.env[envVar] || defaultBin;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 6000, shell: process.platform === 'win32' });
  const found = !(r.error || r.status !== 0);
  if (found) ok(`${label} brain: ${(r.stdout || r.stderr || '').trim().split('\n')[0] || bin}`);
  return { label, bin, found, hint };
}

// A correct setup needs AT LEAST ONE brain. A missing brain you don't use is not a
// problem, so it stays informational (keeps doctor green); zero brains is an error.
function brainsCheck() {
  const results = [
    brainCheck('Kiro', 'KIRO_BIN', 'kiro-cli', ''),
    brainCheck('Cline', 'CLINE_BIN', 'cline', 'npm i -g cline'),
  ];
  const anyFound = results.some((r) => r.found);
  for (const r of results.filter((r) => !r.found)) {
    const msg = `${r.label} brain: '${r.bin}' not found on PATH${r.hint ? ` (${r.hint})` : ''}.`;
    if (anyFound) note(msg); else { errors++; bad(msg); }
  }
  if (!anyFound) bad('No AI brain found — install kiro-cli or run `npm i -g cline`.');
}

function bridgeCheck() {
  const pidFile = path.join(__dirname, 'bridge.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid) return ok('Bridge: not running.');
    try { process.kill(pid, 0); ok(`Bridge: running (pid ${pid}).`); }
    catch (e) { if (e.code === 'EPERM') ok(`Bridge: running (pid ${pid}, other user).`); else ok('Bridge: not running (stale pid file).'); }
  } catch { ok('Bridge: not running.'); }
}

function portCheck() {
  const port = parseInt(process.env.PANEL_PORT || '1234', 10);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.on('connect', () => { s.destroy(); ok(`Web panel port ${port}: in use (panel likely running).`); resolve(); });
    s.on('error', () => { ok(`Web panel port ${port}: free.`); resolve(); });
    s.on('timeout', () => { s.destroy(); ok(`Web panel port ${port}: free.`); resolve(); });
  });
}

(async () => {
  console.log('🩺 cli-controller doctor\n');
  nodeCheck();
  cfg.validate(process.env).forEach(mark);
  brainsCheck();
  bridgeCheck();
  await portCheck();
  console.log(`\n${errors ? '✗' : (warns ? '⚠' : '✓')} ${errors} error(s), ${warns} warning(s).`);
  process.exit(errors ? 1 : 0);
})();
