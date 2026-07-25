// core/memory/json-store.js — the controller's ever-persistent memory.
// Append-only JSONL event log (source of truth) replayed into an in-memory index.
// Zero dependencies, cross-platform, loss-resistant. Search = metadata+text ranking
// (fast at personal scale). Records are never deleted; ending a session only marks it closed.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DIR = process.env.CLI_CONTROLLER_MEMORY_DIR || path.join(os.homedir(), '.cli-controller', 'memory');

// lowercase alphanumeric tokens for cheap overlap scoring
function tokenize(s) { return (s || '').toLowerCase().match(/[a-z0-9]+/g) || []; }
function uniq(arr) { return [...new Set(arr)]; }

class JsonMemory {
  constructor(dir = DEFAULT_DIR) {
    this.dir = dir;
    this.file = path.join(dir, 'events.jsonl');
    this.sessions = new Map();   // sessionId -> record
    this.threads = new Map();    // interfaceThreadKey -> sessionId
    this.decisions = [];         // routing decisions, oldest-first
    this._seq = 0;               // monotonic apply counter — deterministic recency tie-breaker
    this._offset = 0;            // bytes of the log already applied (cross-process tail)
    this._load();
  }

  _ensureDir() { try { fs.mkdirSync(this.dir, { recursive: true }); } catch {} }

  // replay the event log into memory on startup
  _load() {
    let raw; try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of raw.split('\n')) { const t = line.trim(); if (t) { try { this._apply(JSON.parse(t)); } catch {} } }
    this._offset = Buffer.byteLength(raw, 'utf8');
  }

  // pick up events appended by OTHER processes since our last read (bridge ↔ web share one file)
  refresh() {
    let stat; try { stat = fs.statSync(this.file); } catch { return; }
    if (stat.size <= this._offset) return;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const b = Buffer.alloc(stat.size - this._offset);
      fs.readSync(fd, b, 0, b.length, this._offset);
      fs.closeSync(fd);
      chunk = b.toString('utf8');
    } catch { return; }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return;                       // no complete line yet (mid-write)
    const complete = chunk.slice(0, lastNl);
    this._offset += Buffer.byteLength(complete, 'utf8') + 1;
    for (const line of complete.split('\n')) { const t = line.trim(); if (t) { try { this._apply(JSON.parse(t)); } catch {} } }
  }

  // append one event durably, then apply it (never throws to the caller)
  _append(ev) {
    this._ensureDir();
    const line = JSON.stringify(ev) + '\n';
    try { fs.appendFileSync(this.file, line); this._offset += Buffer.byteLength(line, 'utf8'); } catch {}
    this._apply(ev);
  }

  // fold a single event into the in-memory index (used live and on replay)
  _apply(ev) {
    const seq = ++this._seq; // grows in log order (live + replay) → deterministic ordering
    switch (ev.type) {
      case 'session': {
        const cur = this.sessions.get(ev.sessionId) || { sessionId: ev.sessionId, turns: 0, tags: [], createdAt: ev.ts, status: 'open' };
        this.sessions.set(ev.sessionId, { ...cur, brain: ev.brain ?? cur.brain, cwd: ev.cwd ?? cur.cwd, agent: ev.agent ?? cur.agent, title: ev.title ?? cur.title, updatedAt: ev.ts, _seq: seq });
        break;
      }
      case 'turn': {
        const s = this.sessions.get(ev.sessionId); if (!s) break;
        s.turns += 1; s.updatedAt = ev.ts; s.status = 'open'; s._seq = seq;
        if (ev.summary) s.summary = ev.summary;
        if (ev.tags) s.tags = uniq([...(s.tags || []), ...ev.tags]);
        if (!s.title && ev.prompt) s.title = ev.prompt.slice(0, 70);
        break;
      }
      case 'end': { const s = this.sessions.get(ev.sessionId); if (s) { s.status = 'closed'; s.updatedAt = ev.ts; s._seq = seq; } break; }
      case 'thread': this.threads.set(ev.threadKey, ev.sessionId); break;
      case 'decision':
        this.decisions.push({ ts: ev.ts, userText: ev.userText, decision: ev.decision, outcome: ev.outcome });
        if (this.decisions.length > 5000) this.decisions.shift();
        break;
    }
  }

  // ── write API (all best-effort, never throw) ──
  recordSession({ sessionId, brain, cwd, title, agent } = {}) { if (sessionId) this._append({ type: 'session', ts: Date.now(), sessionId, brain, cwd, title, agent }); }
  recordTurn({ sessionId, prompt, summary, tags } = {}) { if (sessionId) this._append({ type: 'turn', ts: Date.now(), sessionId, prompt, summary, tags }); }
  endSession(sessionId) { if (sessionId) this._append({ type: 'end', ts: Date.now(), sessionId }); }
  linkThread(threadKey, sessionId) { if (threadKey && sessionId) this._append({ type: 'thread', ts: Date.now(), threadKey, sessionId }); }
  recordDecision({ userText, decision, outcome } = {}) { this._append({ type: 'decision', ts: Date.now(), userText, decision, outcome }); }

  // ── read API (refresh picks up other processes' writes first) ──
  get(sessionId) { this.refresh(); return this.sessions.get(sessionId) || null; }
  getByThread(threadKey) { this.refresh(); const id = this.threads.get(threadKey); return id ? this.sessions.get(id) || null : null; }

  recent({ limit = 10, cwd } = {}) {
    this.refresh();
    let arr = [...this.sessions.values()];
    if (cwd) arr = arr.filter((s) => s.cwd === cwd);
    return arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b._seq || 0) - (a._seq || 0)).slice(0, limit);
  }

  // rank by query-token overlap (title/summary/tags/cwd) + recency + open-session boost
  search(query, { limit = 8, brain, status } = {}) {
    this.refresh();
    const q = tokenize(query); if (!q.length) return this.recent({ limit });
    const now = Date.now();
    const scored = [];
    for (const s of this.sessions.values()) {
      if (brain && s.brain !== brain) continue;
      if (status && s.status !== status) continue;
      const hay = new Set(tokenize(`${s.title || ''} ${s.summary || ''} ${(s.tags || []).join(' ')} ${s.cwd || ''}`));
      let hits = 0; for (const t of q) if (hay.has(t)) hits++;
      if (!hits) continue;
      const ageDays = (now - (s.updatedAt || now)) / 86400000;
      const score = hits / q.length + (1 / (1 + ageDays)) * 0.5 + (s.status === 'open' ? 0.25 : 0);
      scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => ({ ...x.s, score: Number(x.score.toFixed(3)) }));
  }

  stats() { return { sessions: this.sessions.size, decisions: this.decisions.length, threads: this.threads.size }; }
}

module.exports = { JsonMemory, DEFAULT_DIR, tokenize };
