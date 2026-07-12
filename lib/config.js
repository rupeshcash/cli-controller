// lib/config.js — non-secret config at ~/.cli-controller/config.json, and a
// secret .env writer (owner-only 0600). Keychain is a future enhancement; a
// 0600 .env is the zero-dependency, cross-platform default (no native modules).
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = process.env.CLI_CONTROLLER_HOME || path.join(os.homedir(), '.cli-controller');
const CFG_FILE = () => path.join(CFG_DIR, 'config.json');

function readConfig(dir = CFG_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
  catch { return { version: 1, defaultBrain: 'kiro', workspaces: {} }; }
}
function writeConfig(cfg, dir = CFG_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
function isConfigured(dir = CFG_DIR) { return fs.existsSync(path.join(dir, 'config.json')); }

// merge KEY=VALUE pairs into an env file, preserving existing keys, 0600 perms
function writeEnv(envFile, kv) {
  const lines = {};
  try { for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) lines[l.slice(0, i).trim()] = l.slice(i + 1); } } catch {}
  Object.assign(lines, kv);
  const body = Object.entries(lines).filter(([k]) => k).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, body, { mode: 0o600 });
  try { fs.chmodSync(envFile, 0o600); } catch {}
}

module.exports = { CFG_DIR, CFG_FILE, readConfig, writeConfig, isConfigured, writeEnv };
