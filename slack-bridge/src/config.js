// src/config.js — startup config validation + safety warnings.
// Returns a flat list of { level: 'error'|'warn'|'ok', msg }.
// Only 'error' is fatal (the bridge cannot run). Risky-but-intentional setups
// (allow-all, trust-all) are 'warn' so they never block a deliberate sandbox.
const fs = require('fs');
const os = require('os');

function expandHome(p) {
  return p && p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}
function dirExists(p) {
  try { return !!p && fs.statSync(expandHome(p)).isDirectory(); } catch { return false; }
}

function validate(env = process.env) {
  const out = [];
  const add = (level, msg) => out.push({ level, msg });

  // --- Slack tokens (fatal if missing — cannot connect) ---
  const bot = env.SLACK_BOT_TOKEN;
  const appt = env.SLACK_APP_TOKEN;
  if (!bot) add('error', 'SLACK_BOT_TOKEN is missing (expected an xoxb-… bot token).');
  else if (!/^xoxb-/.test(bot)) add('warn', 'SLACK_BOT_TOKEN does not start with "xoxb-".');
  if (!appt) add('error', 'SLACK_APP_TOKEN is missing (expected an xapp-… Socket Mode token).');
  else if (!/^xapp-/.test(appt)) add('warn', 'SLACK_APP_TOKEN does not start with "xapp-".');

  // --- Access control + tool trust (warnings only) ---
  const raw = (env.SLACK_ALLOWED_USER_IDS || '').trim();
  const allowAll = raw === '*' || raw.toUpperCase() === 'ALL';
  const trust = env.KIRO_TRUST_TOOLS ?? 'fs_read';
  const trustAll = trust.toUpperCase() === 'ALL';
  if (!raw) add('warn', 'SLACK_ALLOWED_USER_IDS is empty — no one can trigger runs. Set it to your Slack user id.');
  if (allowAll) add('warn', 'SLACK_ALLOWED_USER_IDS=* — every user in the workspace can control this machine.');
  if (trustAll) add('warn', 'KIRO_TRUST_TOOLS=ALL — the agent runs tools/commands without asking.');
  if (allowAll && trustAll) add('warn',
    'ALLOW-ALL + TRUST-ALL together = anyone in the workspace can run arbitrary commands on this machine. ' +
    'Safe only on a private/sandbox box. Restrict SLACK_ALLOWED_USER_IDS to your user id for shared workspaces.');

  // --- Workspace paths (warnings) ---
  const cwd = env.KIRO_DEFAULT_CWD;
  if (cwd && !dirExists(cwd)) add('warn', `KIRO_DEFAULT_CWD does not exist: ${cwd}`);
  for (const a of (env.KIRO_DIR_ALIASES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = a.indexOf(':');
    if (i < 0) { add('warn', `Malformed KIRO_DIR_ALIASES entry (expected name:path): "${a}"`); continue; }
    const name = a.slice(0, i).trim();
    const p = a.slice(i + 1).trim();
    if (name && p && !dirExists(p)) add('warn', `Dir alias '${name}' path missing: ${p}`);
  }

  return out;
}

// Print checks with icons; return { errors, warns } counts.
function report(checks, log = console) {
  let errors = 0, warns = 0;
  for (const c of checks) {
    if (c.level === 'error') { errors++; log.error('   ✗ ' + c.msg); }
    else if (c.level === 'warn') { warns++; log.warn('   ⚠ ' + c.msg); }
    else log.log('   ✓ ' + c.msg);
  }
  return { errors, warns };
}

module.exports = { validate, report, expandHome, dirExists };
