// src/kiro.js — SHIM. The Kiro brain moved to core/brain/kiro.js.
// Kept so existing imports (broker.js, index.js) keep working during the P1 refactor.
const k = require('../../core/brain/kiro');
module.exports = {
  runKiro: k.runKiro,
  listSessions: k.listSessions,
  getLatestSessionId: k.getLatestSessionId,
  listAgents: k.listAgents,
  recentSessions: k.recentSessions,
  getSessionInfo: k.getSessionInfo,
  sessionLock: k.sessionLock,
  forceUnlock: k.forceUnlock,
  listModels: k.listModels,
};
