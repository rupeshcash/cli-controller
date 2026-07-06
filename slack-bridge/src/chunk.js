// src/chunk.js — split long output into Slack-safe messages, preferring line breaks.
function chunk(text, max = 3800) {
  if (!text || !text.trim()) return ['(no output)'];
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + line + '\n').length > max) {
      if (buf) { parts.push(buf); buf = ''; }
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
      } else {
        buf = line + '\n';
      }
    } else {
      buf += line + '\n';
    }
  }
  if (buf.trim()) parts.push(buf);
  const n = parts.length;
  return n <= 1 ? parts : parts.map((p, i) => `*(${i + 1}/${n})*\n${p}`);
}
module.exports = { chunk };
