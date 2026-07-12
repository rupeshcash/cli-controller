#!/usr/bin/env node
// bin/cli-controller.js — the front door. Cross-platform (no bash): runs the
// setup wizard, manages the Slack bridge + web panel as Node services, and doctor.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const lc = require('../lib/lifecycle');
const { isConfigured } = require('../lib/config');

const ROOT = path.resolve(__dirname, '..');
const caFile = path.join(ROOT, 'slack-bridge', 'macos-ca.pem');

const bridge = {
  name: 'bridge', cwd: path.join(ROOT, 'slack-bridge'),
  args: [path.join(ROOT, 'slack-bridge', 'src', 'index.js')],
  pidFile: path.join(ROOT, 'slack-bridge', 'bridge.pid'),
  logFile: path.join(ROOT, 'slack-bridge', 'bridge.log'),
  env: fs.existsSync(caFile) ? { NODE_EXTRA_CA_CERTS: caFile } : {}, // folds run.sh's corporate-CA fix into Node
};
const panel = {
  name: 'panel', cwd: path.join(ROOT, 'web-ui'),
  args: [path.join(ROOT, 'web-ui', 'server.js')],
  pidFile: path.join(ROOT, 'web-ui', 'panel.pid'),
  logFile: path.join(ROOT, 'web-ui', 'panel.log'),
  env: {},
};
const SVCS = { bridge, panel };

const line = (s = '') => process.stdout.write(s + '\n');
function svcStatus() {
  for (const s of [bridge, panel]) { const st = lc.status(s); line(`  ${s.name.padEnd(7)} ${st.running ? '● running (pid ' + st.pid + ')' : '○ stopped'}`); }
}

async function main() {
  const [cmd, sub] = process.argv.slice(2);

  // per-service control: `cli-controller bridge start`, `panel restart`, …
  if (SVCS[cmd]) {
    const svc = SVCS[cmd];
    switch (sub || 'status') {
      case 'start': { const r = lc.start(svc); line(r.already ? `${cmd} already running (pid ${r.pid})` : `⚡ ${cmd} started (pid ${r.pid})`); break; }
      case 'stop': line(lc.stop(svc).stopped ? `🛑 ${cmd} stopped` : `${cmd} not running`); break;
      case 'restart': { const r = lc.restart(svc); line(`↻ ${cmd} restarted (pid ${r.pid})`); break; }
      default: svcStatus();
    }
    return 0;
  }

  switch (cmd) {
    case 'setup': return require('../lib/setup').run({ root: ROOT, bridge, panel });
    case 'doctor': return spawnSync(process.execPath, [path.join(ROOT, 'slack-bridge', 'doctor.js')], { stdio: 'inherit' }).status || 0;
    case 'start': lc.start(bridge); lc.start(panel); line('⚡ started:'); svcStatus(); return 0;
    case 'stop': lc.stop(bridge); lc.stop(panel); line('🛑 stopped both.'); return 0;
    case 'restart': lc.restart(bridge); lc.restart(panel); line('↻ restarted:'); svcStatus(); return 0;
    case 'status': line('cli-controller:'); svcStatus(); return 0;
    case undefined:
      if (!isConfigured()) { line("👋 First run — let's get you set up.\n"); return require('../lib/setup').run({ root: ROOT, bridge, panel }); }
      line('cli-controller — commands: setup · start · stop · restart · status · doctor · bridge <cmd> · panel <cmd>'); line(''); svcStatus(); return 0;
    default:
      line(`Unknown command: ${cmd}`); line('Commands: setup · start · stop · restart · status · doctor · bridge <start|stop|restart|status> · panel <…>'); return 1;
  }
}

main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
