// src/parse.js — pure parsing/util helpers (no side effects; unit-tested).
// Extracted from index.js so command parsing can be tested and later reused by
// other interfaces (see plans/roadmap/02-interfaces.md).
const os = require('os');

function expandHome(p) {
  return p && p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

function resolveDir(aliases, v) {
  return expandHome((aliases && aliases[v]) || v);
}

// Parse a "!new [agent=..] [dir=..|alias] [model=..] [-v|-q] <prompt>" message.
// Returns { patch, prompt }. `aliases` maps dir-alias name -> path.
function parseNew(text, aliases = {}) {
  let rest = text.slice(4).trim(); // after "!new"
  const patch = {};
  const optRe = /^(agent|dir|cwd|model|brain|verbose)\s*=\s*(\S+)\s*/i;
  const flagVRe = /^(?:-v|--verbose)(?:\s+|$)/i;
  const flagQRe = /^(?:-q|--quiet)(?:\s+|$)/i;
  for (;;) {
    let m;
    if ((m = rest.match(optRe))) {
      const k = m[1].toLowerCase(); const v = m[2];
      if (k === 'agent') patch.agent = v;
      else if (k === 'dir' || k === 'cwd') patch.cwd = resolveDir(aliases, v);
      else if (k === 'model') patch.model = v;
      else if (k === 'brain') patch.brain = v.toLowerCase();
      else if (k === 'verbose') patch.verbose = /^(true|on|yes|1)$/i.test(v);
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((m = rest.match(flagVRe))) { patch.verbose = true; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(flagQRe))) { patch.verbose = false; rest = rest.slice(m[0].length); continue; }
    break;
  }
  // Bare first token as a directory: a known alias, or something path-like.
  if (patch.cwd === undefined) {
    const first = rest.split(/\s+/)[0] || '';
    if (aliases[first]) { patch.cwd = resolveDir(aliases, first); rest = rest.slice(first.length).trim(); }
    else if (first.startsWith('/') || first.startsWith('~')) { patch.cwd = expandHome(first); rest = rest.slice(first.length).trim(); }
  }
  return { patch, prompt: rest.trim() };
}

module.exports = { expandHome, resolveDir, parseNew };
