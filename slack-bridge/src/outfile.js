// src/outfile.js — outbound file delivery: pull a file from the session's workspace into a Slack thread.
//
// Powers the `!file <path>` controller command. The agent works in a session `cwd` (tracked per thread in
// state.json); this lets you say "send me that file here" and get it as a native, syntax-highlighted Slack
// upload (Slack derives highlighting from the filename extension).
//
// SECURITY: this reads arbitrary bytes off the user's disk and pushes them to Slack. Two guards, both pure
// and unit-tested:
//   1. resolvePath() confines the target to the session cwd — no `..` traversal, no absolute path escaping cwd.
//   2. isBlockedSecret() refuses obvious secret files (.env, keys, credentials) so a stray `!file .env` can't
//      leak them. It's the user's own allow-listed account, but the guard prevents a careless one-liner.
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

module.exports = { isBlockedSecret, resolvePath, readForUpload, deliverWorkspaceFile, errText, FILE_MAX_BYTES, SECRET_PATTERNS, SECRET_SEGMENTS };
