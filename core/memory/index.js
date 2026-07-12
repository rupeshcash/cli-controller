// core/memory/index.js — factory for the manager's persistent memory.
// Default backend: local append-only JSONL (zero deps, see json-store.js).
// To add an ai-memory HTTP backend later: implement the same method surface
// (recordSession/recordTurn/linkThread/recordDecision/get/getByThread/recent/search)
// and select it here via env (e.g. CLI_CONTROLLER_MEMORY_BACKEND=aimemory).
const { JsonMemory } = require('./json-store');

let _instance = null;
function memory() { if (!_instance) _instance = new JsonMemory(); return _instance; } // lazy singleton

module.exports = { memory, JsonMemory };
