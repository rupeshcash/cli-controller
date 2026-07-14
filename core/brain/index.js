// core/brain/index.js — Brain registry. Adding a brain = one require + one map entry.
// See plans/roadmap/01-brain-multi-cli.md.
const kiro = require('./kiro');

const brains = {
  kiro: kiro.adapter,
};

// Cline is wired in P2 (core/brain/cline.js).
try { brains.cline = require('./cline').adapter; } catch { /* not present yet */ }

const DEFAULT_BRAIN = process.env.CLI_CONTROLLER_DEFAULT_BRAIN || process.env.KIRO_DEFAULT_BRAIN || 'kiro';

function getBrain(id) {
  return (id && brains[id]) || brains[DEFAULT_BRAIN] || brains.kiro;
}
function listBrains() { return Object.keys(brains); }
function hasBrain(id) { return !!(id && brains[id]); }

module.exports = { getBrain, listBrains, hasBrain, brains, DEFAULT_BRAIN };
