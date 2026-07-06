// src/format.js — make Kiro output read cleanly in Slack.
//
// Slack uses "mrkdwn", not GitHub-flavored Markdown. Kiro/LLM output is GFM, so
// without conversion it renders as messy plaintext. This module:
//   1) converts common Markdown → Slack mrkdwn (bold, headings, bullets, links)
//   2) prettifies Kiro's tool-activity lines into compact, scannable rows
// Code blocks and inline code are protected so their contents are never altered.

const ZWB = '\u0000B'; // placeholder markers (null byte won't appear in text)
const ZWI = '\u0000I';

function mdToMrkdwn(input) {
  let s = input;

  // Protect fenced code blocks, then inline code.
  const blocks = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => { blocks.push(m); return `${ZWB}${blocks.length - 1}\u0000`; });
  const inline = [];
  s = s.replace(/`[^`\n]+`/g, (m) => { inline.push(m); return `${ZWI}${inline.length - 1}\u0000`; });

  // Links: [text](url) -> <url|text>
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  // Bold: **x** / __x__ -> *x*
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  s = s.replace(/(^|[^_])__([^_\n]+)__(?!_)/g, '$1*$2*');
  // Headings: leading #'s -> bold line
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*');
  // Bullets: "- ", "* ", "+ " at line start -> "• " (requires the trailing space,
  // so it won't touch things like "-rw-r--r--" in command output)
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ');

  // Restore inline code then blocks.
  s = s.replace(new RegExp(`${ZWI}(\\d+)\\u0000`, 'g'), (_, i) => inline[+i]);
  s = s.replace(new RegExp(`${ZWB}(\\d+)\\u0000`, 'g'), (_, i) => blocks[+i]);
  return s;
}

function prettifyTrace(input) {
  return input.split('\n').map((line) => {
    let m;
    if ((m = line.match(/^\s*I will run the following command:\s*(.+?)\s*\(using tool:[^)]*\)\s*$/i))) return `🔧 \`${m[1]}\``;
    if ((m = line.match(/^\s*Reading directory:\s*(.+?)\s*\(using tool:[^)]*\).*$/i))) return `📂 \`${m[1]}\``;
    if ((m = line.match(/^\s*Reading file[s]?:\s*(.+?)\s*(?:\(using tool:[^)]*\))?\s*$/i))) return `📄 \`${m[1]}\``;
    if ((m = line.match(/^\s*(?:Writing|Creating|Updating|Editing)\s+file:?\s*(.+?)\s*(?:\(using tool:[^)]*\))?\s*$/i))) return `✏️ \`${m[1]}\``;
    if (/^\s*✓\s+Successfully\b/i.test(line)) return line.replace(/^\s*✓\s+Successfully\s+/i, '✓ ');
    if ((m = line.match(/^\s*-\s*Completed in\s*(.+?)\s*$/i))) return `⏱ ${m[1]}`;
    if ((m = line.match(/^\s*Purpose:\s*(.+)$/i))) return `_↳ ${m[1]}_`;
    return line;
  }).join('\n');
}

// Full pipeline for Slack messages (inline). Prettify trace lines first (they add
// inline code), then convert Markdown so the protection covers everything.
function formatForSlack(text) {
  if (!text || !text.trim()) return text;
  return mdToMrkdwn(prettifyTrace(text));
}

module.exports = { formatForSlack, mdToMrkdwn, prettifyTrace };
