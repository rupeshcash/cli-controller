// src/outfile.js — Slack-AGNOSTIC workspace-file egress toolkit.
//
// One cohesive responsibility: safely turn a natural request into deliverable file bytes.
//   find  → findWorkspaceFiles / parseFetchQuery   (locate by name/qualifier under cwd)
//   guard → isBlockedSecret / resolvePath          (secret refusal + cwd confinement)
//   read  → readForUpload                          (stat + size cap + read)
//   deliver → deliverWorkspaceFile                 (drives an INJECTED uploader)
//
// INTEGRATION BOUNDARY: this module has NO Slack dependency. The transport (Slack
// files.uploadV2) is injected by the caller — `slack-bridge/src/index.js`
// (`sendWorkspaceFileToThread`) is the only place that knows about Slack. That keeps
// discovery/guards/read fully unit-testable and reusable by any interface (web UI, etc.).
//
// Powers `!file <path>` (exact) and the controller's `!<nl> fetch` action (fuzzy). The agent
// works in a session `cwd` (tracked per thread in state.json).
//
// SECURITY: this reads arbitrary bytes off the user's disk. Two guards, both pure and unit-tested:
//   1. resolvePath() confines the target to the session cwd — no `..` traversal, no absolute escape.
//   2. isBlockedSecret() refuses obvious secret files (.env, keys, credentials) so neither an exact
//      `!file .env` nor a fuzzy fetch can surface them.
const fs = require('fs');
const path = require('path');

const FILE_MAX_BYTES = parseInt(process.env.KIRO_FILE_MAX_BYTES, 10) || 2 * 1024 * 1024; // 2MB default

// Basename patterns we never upload. Conservative allow-by-default; block the obvious secret carriers.
const SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,           // .env, .env.local, .env.production …
  /\.pem$/i,
  /\.(key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[._-])credentials?([._-]|$)/i,
  /^\.npmrc$/i,
  /^\.git-credentials$/i,
  /^\.netrc$/i,
];
// Path segments that mean "secret store" regardless of the filename inside them.
const SECRET_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws']);

function isBlockedSecret(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/');
  const base = norm.split('/').filter(Boolean).pop() || '';
  if (SECRET_PATTERNS.some((re) => re.test(base))) return true;
  return norm.split('/').some((seg) => SECRET_SEGMENTS.has(seg));
}

// Resolve `relPath` against `cwd`, confined to cwd. Returns { abs } or { error }.
// Absolute paths are allowed only if they still land inside cwd; `..` escaping cwd is rejected.
function resolvePath(cwd, relPath) {
  if (!relPath || !String(relPath).trim()) return { error: 'no path given' };
  const base = path.resolve(cwd || process.cwd());
  const abs = path.resolve(base, String(relPath).trim());
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { error: 'path is outside the session workspace' };
  }
  return { abs };
}

// Full read pipeline: guard → resolve → stat → read. Returns { name, buf, size } or { error }.
// Never throws. The secret guard runs FIRST so a blocked path reports "secret", not "not found".
function readForUpload(cwd, relPath, maxBytes = FILE_MAX_BYTES) {
  if (isBlockedSecret(relPath)) return { error: `refusing to send "${relPath}" — looks like a secret file` };
  const r = resolvePath(cwd, relPath);
  if (r.error) return { error: r.error };
  let st;
  try { st = fs.statSync(r.abs); }
  catch { return { error: `not found: "${relPath}"` }; }
  if (st.isDirectory()) return { error: `"${relPath}" is a directory, not a file` };
  if (st.size > maxBytes) return { error: `"${relPath}" is ${(st.size / 1048576).toFixed(1)}MB — over the ${Math.round(maxBytes / 1048576)}MB limit` };
  let buf;
  try { buf = fs.readFileSync(r.abs); }
  catch (e) { return { error: `read failed for "${relPath}": ${e.message}` }; }
  return { name: path.basename(r.abs), buf, size: buf.length };
}

// Normalize an error thrown by the injected uploader (Slack Web API errors nest under e.data.error).
function errText(e) {
  return (e && e.data && e.data.error) || (e && e.message) || 'unknown error';
}

// ── Natural-language file discovery (powers the controller's `fetch` action) ──
// Directories we never descend into (heavy / irrelevant), plus all dotdirs.
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.cache', 'target', 'vendor', 'coverage', '.next', '.venv', '__pycache__']);
// Words to drop from a natural-language request so only the filename + qualifiers remain.
const STOP_WORDS = new Set(['the', 'me', 'for', 'from', 'please', 'can', 'you', 'fetch', 'get', 'file',
  'find', 'send', 'show', 'it', 'is', 'somewhere', 'in', 'project', 'my', 'of', 'give', 'pull', 'grab',
  'that', 'this', 'and', 'to', 'a', 'an', 'want', 'need', 'the', 'doc', 'document', 'please']);

// Parse a request like "the design.md for ticket ENG-42" → { name:'design.md', qualifiers:['eng-42'] }.
function parseFetchQuery(query) {
  const tokens = (String(query || '').toLowerCase().match(/[a-z0-9][\w.\-/]*/g) || []);
  const name = tokens.find((t) => /^[\w-]+\.[\w-]+$/.test(t)) || null; // a filename with an extension
  const qualifiers = tokens.filter((t) => t !== name && t.length >= 2 && !STOP_WORDS.has(t));
  return { name, qualifiers };
}

// Search `cwd` for files matching a natural-language `query`. Returns ranked relative paths.
// Bounded (maxEntries) and safe: skips ignored/hidden dirs and secret files, never escapes cwd.
function findWorkspaceFiles(cwd, query, { limit = 10, maxEntries = 20000 } = {}) {
  const base = path.resolve(cwd || process.cwd());
  const { name, qualifiers } = parseFetchQuery(query);
  if (!name && qualifiers.length === 0) return [];
  const results = [];
  let seen = 0;
  const stack = [base];
  while (stack.length && seen < maxEntries) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > maxEntries) break;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const bn = e.name.toLowerCase();
      const rel = path.relative(base, path.join(dir, e.name));
      if (isBlockedSecret(rel)) continue;
      let score = 0;
      if (name) {
        if (bn === name) score += 100;
        else if (bn.includes(name)) score += 40;
        else continue; // a filename was named but this basename doesn't match → skip
      } else {
        // No filename token: require a qualifier to hit the basename.
        const hits = qualifiers.filter((q) => bn.includes(q)).length;
        if (!hits) continue;
        score += hits * 20;
      }
      const relLower = rel.toLowerCase();
      for (const q of qualifiers) if (relLower.includes(q)) score += 10; // path context (e.g. ticket id folder)
      results.push({ rel, score });
    }
  }
  results.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  return results.slice(0, limit).map((r) => r.rel);
}

// Orchestrate delivery of one workspace file through an INJECTED `upload` function.
// `upload({ filename, buf, size })` is expected to be async and perform the actual transport
// (in the bridge: a Slack files.uploadV2 call). Kept transport-agnostic so this is unit-testable
// with a fake uploader and carries no @slack/bolt dependency.
// Returns { ok:true, name, size } or { ok:false, error }. Never throws.
async function deliverWorkspaceFile({ cwd, relPath, upload, maxBytes = FILE_MAX_BYTES }) {
  const r = readForUpload(cwd, relPath, maxBytes);
  if (r.error) return { ok: false, error: r.error };
  try {
    await upload({ filename: r.name, buf: r.buf, size: r.size });
    return { ok: true, name: r.name, size: r.size };
  } catch (e) {
    return { ok: false, error: `upload failed for "${relPath}": ${errText(e)}` };
  }
}

module.exports = { isBlockedSecret, resolvePath, readForUpload, deliverWorkspaceFile, findWorkspaceFiles, parseFetchQuery, errText, FILE_MAX_BYTES, SECRET_PATTERNS, SECRET_SEGMENTS };
