// src/sessions.js — per-Slack-conversation state, persisted to state.json.
//
// Persistence is ATOMIC and RECOVERABLE. A prior version did a bare
// `fs.writeFileSync(state.json)` (not atomic) and, on read, silently reset to
// `{}` if the JSON failed to parse. A crash/restart mid-write therefore left a
// truncated file that wiped EVERY thread's session on the next boot — every
// thread then reported "This thread has no session". We now:
//   • write to a temp file and `rename` it into place (atomic swap), and
//   • keep a `.bak` snapshot of the last-good state; on load we fall back to it
//     and NEVER silently discard non-empty prior state.
const fs = require('fs');
const path = require('path');

function createStore(file) {
  let state = {};

  function load() {
    // Try the primary file, then the backup. Only end up empty if BOTH are
    // absent/unreadable — never wipe silently on a parse error.
    for (const f of [file, `${file}.bak`]) {
      let raw;
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[sessions] could not read ${path.basename(f)}: ${e.message}`);
        continue;
      }
      try {
        state = JSON.parse(raw);
        if (f !== file) {
          console.warn(`[sessions] primary state was unreadable — recovered ${Object.keys(state).length} thread(s) from ${path.basename(f)}`);
          // Atomic repair: temp-write then rename, so a crash mid-repair can't leave
          // the primary truncated (which would defeat the recovery we just did).
          try {
            const repairTmp = `${file}.tmp`;
            fs.writeFileSync(repairTmp, raw);
            fs.renameSync(repairTmp, file);
          } catch (_) { /* best effort — .bak still holds the good copy */ }
        }
        return;
      } catch (e) {
        console.warn(`[sessions] ${path.basename(f)} is corrupt (${e.message}) — trying next source`);
      }
    }
    state = {};
  }

  function save() {
    let data;
    try { data = JSON.stringify(state, null, 2); } catch (e) { console.warn(`[sessions] serialize failed: ${e.message}`); return; }
    const tmp = `${file}.tmp`;
    try {
      // Refresh .bak ONLY from a primary we can prove is valid JSON — never let a
      // corrupt-but-not-yet-repaired primary clobber the last-known-good backup.
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, `${file}.bak`);
      } catch (_) { /* no prior file yet, or it's still corrupt — keep the existing .bak */ }
      fs.writeFileSync(tmp, data);   // fully write to temp first
      fs.renameSync(tmp, file);      // atomic swap — readers never see a partial file
    } catch (e) {
      console.warn(`[sessions] save failed: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
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
  return { get, set, has, remove };
}

// Default singleton bound to the bridge's state.json (the app uses this).
const store = createStore(path.join(__dirname, '..', 'state.json'));
store.createStore = createStore; // exposed for tests
module.exports = store;
