// src/attachments.js — Slack file uploads (images + text snippets) → local temp files → prompt context.
//
// Slack delivers uploads as a `file_share` message carrying `message.files[]`. Neither kiro-cli nor
// cline take an image on the command line, so the mechanism is: download the file to a controlled temp
// dir, reference its path in the prompt, and let the brain's own file-read tool consume it. Kiro reads
// images by path via fs_read Image mode (see core/brain/kiro.js capabilities); Cline can't yet (text only).
//
// Requires the Slack bot to have the `files:read` OAuth scope; downloads use the bot token as a Bearer.
// The bot token is used transiently for the download only — never logged.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DL_DIR = path.join(os.tmpdir(), 'cli-controller-uploads');
try { fs.mkdirSync(DL_DIR, { recursive: true }); } catch { /* best-effort */ }

const MAX_BYTES = parseInt(process.env.KIRO_ATTACH_MAX_BYTES, 10) || 15 * 1024 * 1024;      // per-file cap (15MB)
const INLINE_TEXT_MAX = parseInt(process.env.KIRO_ATTACH_INLINE_TEXT_MAX, 10) || 12000;      // inline snippet if ≤ this many chars
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function hasFiles(message) { return Array.isArray(message && message.files) && message.files.length > 0; }

// Sanitize a Slack-provided filename for safe use inside DL_DIR (no traversal, no separators).
function safeName(name, id, fallbackExt) {
  let base = (name || `file-${id || 'x'}`).replace(/[^\w.\-]/g, '_').slice(-80);
  if (!path.extname(base) && fallbackExt) base += `.${fallbackExt}`;
  return base;
}

function classify(f) {
  const ft = (f.filetype || '').toLowerCase();
  const mt = (f.mimetype || '').toLowerCase();
  if (IMAGE_EXT.has(ft) || mt.startsWith('image/')) return 'image';
  return 'text'; // snippets, code, plain text, and anything else we can read as UTF-8
}

async function downloadOne(f, token) {
  const url = f.url_private_download || f.url_private;
  if (!url) return { error: `no download URL for "${f.name || f.id}"` };
  if (f.size && f.size > MAX_BYTES) return { error: `"${f.name || f.id}" is ${(f.size / 1048576).toFixed(1)}MB — over the ${Math.round(MAX_BYTES / 1048576)}MB limit` };
  let resp;
  try { resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
  catch (e) { return { error: `download failed for "${f.name || f.id}": ${e.message}` }; }
  if (!resp || !resp.ok) return { error: `download failed for "${f.name || f.id}": HTTP ${resp && resp.status}` };
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_BYTES) return { error: `"${f.name || f.id}" exceeds the ${Math.round(MAX_BYTES / 1048576)}MB limit` };
  const kind = classify(f);
  const ext = (f.filetype || '').toLowerCase() || (kind === 'image' ? 'png' : 'txt');
  const dest = path.join(DL_DIR, `${Date.now()}-${safeName(f.name, f.id, ext)}`);
  try { fs.writeFileSync(dest, buf); } catch (e) { return { error: `save failed for "${f.name || f.id}": ${e.message}` }; }
  const out = { kind, path: dest, name: f.name || path.basename(dest), size: buf.length };
  if (kind === 'text') { try { out.content = buf.toString('utf8'); } catch { out.content = null; } }
  return out;
}

// Download every file on the message. Returns { images, snippets, errors, paths }. Never throws.
async function downloadFiles(message, token) {
  const images = [], snippets = [], errors = [], paths = [];
  if (!token) return { images, snippets, errors: ['no SLACK_BOT_TOKEN available to download attachments'], paths };
  for (const f of (message.files || [])) {
    const r = await downloadOne(f, token);
    if (r.error) { errors.push(r.error); continue; }
    paths.push(r.path);
    (r.kind === 'image' ? images : snippets).push(r);
  }
  return { images, snippets, errors, paths };
}

// Prompt-context block appended to the user's text. `includeImages=false` drops image path refs
// (brain can't see them) while still forwarding any text-snippet content.
function buildContext({ images = [], snippets = [] } = {}, { includeImages = true } = {}) {
  const parts = [];
  if (includeImages && images.length) {
    parts.push(
      images.map((im) => `[Attached image: ${im.path}]`).join('\n') +
      `\nView the attached image file(s) above with your file-read tool, then address the request.`
    );
  }
  for (const s of snippets) {
    if (s.content != null && s.content.length <= INLINE_TEXT_MAX) {
      parts.push(`[Attached text snippet "${s.name}"]\n\`\`\`\n${s.content}\n\`\`\``);
    } else {
      parts.push(`[Attached text file "${s.name}" at ${s.path}] — read it with your file-read tool.`);
    }
  }
  return parts.join('\n\n');
}

// Short human-facing acknowledgement of what was received.
function describe({ images = [], snippets = [], errors = [] } = {}, { includeImages = true } = {}) {
  const bits = [];
  if (images.length) bits.push(`${images.length} image${images.length > 1 ? 's' : ''}${includeImages ? '' : ' (skipped — this brain can’t view images)'}`);
  if (snippets.length) bits.push(`${snippets.length} text snippet${snippets.length > 1 ? 's' : ''}`);
  let msg = bits.length ? `📎 Received ${bits.join(' + ')}.` : '';
  if (errors.length) msg += (msg ? '\n' : '') + `⚠️ ${errors.join('; ')}`;
  return msg;
}

// Best-effort cleanup of old downloads so the temp dir doesn't grow unbounded. Called at startup.
function sweepOld(maxAgeMs = 24 * 3600 * 1000) {
  const now = Date.now();
  let files;
  try { files = fs.readdirSync(DL_DIR); } catch { return; }
  for (const f of files) {
    const p = path.join(DL_DIR, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

module.exports = { hasFiles, downloadFiles, buildContext, describe, sweepOld, DL_DIR, MAX_BYTES, INLINE_TEXT_MAX };
