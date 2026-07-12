#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const fs = require('fs');
const brains = require('../core/brain');

const envFile = path.join(__dirname, '.env');
const line = (s = '') => process.stdout.write(s + '\n');

async function main() {
  let ok = true;
  line('━━ cli-controller doctor ━━');
  line(`Node: ${process.version}`);
  line(`Config: ${fs.existsSync(envFile) ? envFile : '(missing slack-bridge/.env)'}`);

  const bot = process.env.SLACK_BOT_TOKEN || '';
  const app = process.env.SLACK_APP_TOKEN || '';
  const allowed = process.env.SLACK_ALLOWED_USER_IDS || '';
  for (const [name, value, prefix] of [
    ['SLACK_BOT_TOKEN', bot, 'xoxb-'],
    ['SLACK_APP_TOKEN', app, 'xapp-'],
  ]) {
    const good = value.startsWith(prefix);
    line(`${good ? '✓' : '✗'} ${name}${good ? '' : ` missing or not ${prefix}...`}`);
    ok &&= good;
  }
  line(`${allowed ? '✓' : '✗'} SLACK_ALLOWED_USER_IDS${allowed ? ` = ${allowed}` : ' is empty (bot will ignore everyone)'}`);
  ok &&= !!allowed;

  line('\nBrains:');
  for (const id of brains.listBrains()) {
    try {
      const d = await brains.getBrain(id).doctor();
      line(`  ${d.ok ? '✓' : '✗'} ${id} — ${d.msg || ''}`);
    } catch (e) {
      line(`  ✗ ${id} — ${e.message || e}`);
    }
  }
  const def = process.env.CLI_CONTROLLER_DEFAULT_BRAIN || process.env.KIRO_DEFAULT_BRAIN || brains.DEFAULT_BRAIN;
  line(`\nDefault brain: ${def}`);
  if (!brains.hasBrain(def)) { line(`✗ Unknown default brain '${def}'`); ok = false; }
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });