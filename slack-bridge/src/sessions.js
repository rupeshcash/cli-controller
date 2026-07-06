// src/sessions.js — per-Slack-conversation state, persisted to state.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state.json');
let state = {};

function load() {
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = {}; }
}
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch (e) { /* best effort */ }
}

function defaults() {
  return {
    cwd: process.env.KIRO_DEFAULT_CWD || process.cwd(),
    sessionId: null,
    agent: process.env.KIRO_AGENT || null,
    model: process.env.KIRO_MODEL || null,
    verbose: true,
  };
}

function get(channel) {
  if (!state[channel]) state[channel] = defaults();
  return state[channel];
}
function has(channel) {
  return Object.prototype.hasOwnProperty.call(state, channel);
}
function set(channel, patch) {
  state[channel] = { ...get(channel), ...patch };
  save();
}
function remove(channel) {
  if (has(channel)) { delete state[channel]; save(); }
}

load();
module.exports = { get, set, has, remove };
