// src/format.js — render Kiro output for Slack.
//
// Formatting uses the gold-standard `slackify-markdown` (AST-based Markdown →
// Slack mrkdwn). The only custom piece is `stripToolTrace`: hiding Kiro's
// tool-activity lines for "quiet" mode — this is Kiro-specific, so no library
// exists for it. It is written to NEVER swallow the assistant's answer.

const { slackifyMarkdown } = require('slackify-markdown');

// Standalone one-line trace markers Kiro prints while working.
const TOOL_LINE = /^\s*(Reading (?:directory|file)s?:|Searching for files:|I will run the following command:|Purpose:|Using tool:|✓\s|-\s*Completed in\b|Creating file|Writing to file|Updating file|Editing file)/i;
const TOOL_START = /\(using tool:/i;               // start of a tool invocation
const TOOL_END = /(-\s*Completed in\b|^\s*✓\s+Successfully)/i; // its completion

// Remove tool-activity (invocation lines + their raw output blocks), leaving the
// assistant's prose. Safety: a tool block is only suppressed if a closing marker
// exists ahead — otherwise we keep the content so the final answer is never lost.
function stripToolTrace(text) {
  const lines = (text || '').split('\n');
  const out = [];
  let inTool = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inTool) {
      if (TOOL_END.test(line)) inTool = false; // consume closer, then resume
      continue;
    }
    if (TOOL_START.test(line)) {
      if (!TOOL_END.test(line)) {
        const closesAhead = lines.slice(i + 1).some((l) => TOOL_END.test(l));
        if (closesAhead) inTool = true; // enter block only if it will close
      }
      continue; // drop the invocation line itself
    }
    if (TOOL_LINE.test(line)) continue; // drop standalone marker lines
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function toSlack(text) {
  if (!text || !text.trim()) return text || '';
  try { return slackifyMarkdown(text); } catch (e) { return text; }
}

// quiet (default): strip tool trace, then Slack-format the assistant prose.
// verbose: Slack-format the full output (trace included).
function formatForSlack(text, { quiet = true } = {}) {
  const base = quiet ? stripToolTrace(text) : text;
  const finalText = base && base.trim() ? base : (text || ''); // never emit empty when there was output
  return toSlack(finalText);
}

module.exports = { formatForSlack, stripToolTrace, toSlack };
