// lib/setup.js — the onboarding wizard: pick a brain → capture+validate Slack
// tokens → write config/secrets → offer to start → tell the user to chat the bot.
// Interactive shell is thin; all logic lives in tested libs (config/slack/brain).
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const path = require('path');
const { readConfig, writeConfig, writeEnv } = require('./config');
const { authTest } = require('./slack');
const lc = require('./lifecycle');
const brains = require('../core/brain');

const line = (s = '') => stdout.write(s + '\n');

async function run({ bridge, panel }) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q, def) => rl.question(def ? `${q} [${def}]: ` : `${q}: `).then((a) => (a.trim() || def || ''));
  try {
    line('\n━━ cli-controller setup ━━\n');

    // 1) Brain — detect installed CLIs, pick a default
    line('1) AI brain — checking what is installed…');
    const available = [];
    for (const id of brains.listBrains()) {
      let ok = false, msg = '';
      try { const d = await brains.getBrain(id).doctor(); ok = !!d.ok; msg = d.msg || ''; } catch {}
      line(`   ${ok ? '✓' : '✗'} ${id}${msg ? ' — ' + msg : ''}`);
      if (ok) available.push(id);
    }
    if (!available.length) line('   ⚠ None detected on PATH. Install kiro-cli or `npm i -g cline`, then re-run `cli-controller setup`.');
    const defaultBrain = (await ask('   Default brain', available[0] || 'kiro')).toLowerCase();

    // 2) Slack — capture + validate tokens
    line('\n2) Slack bridge — you need two tokens from https://api.slack.com/apps (create an app "From scratch"):');
    line('   • Enable Socket Mode → generates an app-level token (xapp-…).');
    line('   • Add bot scopes: chat:write, reactions:write, files:write, im:history, app_mentions:read, channels:history, groups:history.');
    line('   • Install to your workspace → bot token (xoxb-…).');
    const bot = await ask('   Bot token (xoxb-)');
    const app = await ask('   App token (xapp-)');
    let allow = '';
    if (bot) {
      stdout.write('   Validating bot token… ');
      const a = await authTest(bot);
      if (a.ok) { allow = a.userId; line(`ok — workspace "${a.team}", you are ${a.userId}. Allow-list = just you (safe default).`); }
      else { line(`⚠ auth.test failed (${a.error}) — saving anyway; re-run setup to fix.`); }
    }

    // 3) Persist: non-secret config + secret .env (0600)
    const cfg = readConfig(); cfg.defaultBrain = defaultBrain; writeConfig(cfg);
    const kv = { CLI_CONTROLLER_DEFAULT_BRAIN: defaultBrain, KIRO_DEFAULT_BRAIN: defaultBrain };
    if (bot) kv.SLACK_BOT_TOKEN = bot;
    if (app) kv.SLACK_APP_TOKEN = app;
    if (allow) kv.SLACK_ALLOWED_USER_IDS = allow;
    writeEnv(path.join(bridge.cwd, '.env'), kv);
    line(`\n   Saved config → ~/.cli-controller/config.json · secrets → ${path.join(bridge.cwd, '.env')} (owner-only).`);

    // 4) Start + hand off to chat-driven onboarding
    const go = (await ask('\n3) Start the bridge + web panel now? (y/n)', 'y')).toLowerCase();
    if (go.startsWith('y')) {
      lc.start(bridge); lc.start(panel);
      line('   ⚡ Started. Web cockpit → http://localhost:1234');
      line('\n✓ Done. Now open Slack, DM your bot, and just tell it what to do —');
      line('  or keep going in the terminal with `cli-controller`.');
    } else {
      line('\n✓ Saved. Start any time with `cli-controller start`.');
    }
    return 0;
  } finally { rl.close(); }
}

module.exports = { run };
