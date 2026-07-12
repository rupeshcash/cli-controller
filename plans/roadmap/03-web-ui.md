# 03 — Web cockpit: tracking + CLI chat

> Read [`README.md`](README.md) §2 (doctrine) + §5 (constraints).
> Outcome: the web UI stops being a read-only monitor and becomes a **daily-driver cockpit** — search everything, and **start & continue sessions in the browser** — while honestly reflecting each brain's limits (no fake streaming, Kiro resume-lock handled).

---

## 1. Where the web UI is today

`web-ui/server.js` (Express, `127.0.0.1:1234`) + a single inline `public/index.html`. It reads `~/.kiro/sessions/cli/*.json`, reads `slack-bridge/state.json`, tails `bridge.log`, and shells out to the `bridge` script. It is a **viewer + bridge remote**. It does not start or continue sessions, and it is Kiro-only.

The core extraction (`01`) and the Interface contract (`02` §5) are what let the web UI graduate: it becomes a **peer Interface** that drives the same core as Slack.

## 2. Session tracking improvements

### 2.1 Unified, brain-aware session list
- List sessions across **all brains** (read each brain's `listSessions()`; native files are truth — constraint #5), tagged with a **brain badge** (Kiro/Cline) and a **source badge** (Terminal / Slack / Web) derived from the pointer store.
- Columns: title, brain, source, workspace, agent, model, last-updated, message count, status (🔒 if live elsewhere), context% *if the brain exposes it*.

### 2.2 Search (the sticky feature)
- **Level 1 (P4): metadata search** over a **derived SQLite FTS5 index** — title, workspace, brain, source, agent, model, date, status. Rebuildable from native files (`doctor --reindex`); never authoritative (constraint #5).
- **Level 2 (later): transcript search** — index prompts/responses from the `.jsonl` on each turn.
- **Level 3 (later): semantic search** — optional embeddings. Not P4.
- Client-side filter/sort stays for the loaded set (already instant); server search kicks in for the full corpus.

### 2.3 Richer session detail
Per session: full transcript, files touched / commands run (when the brain surfaces them), errors, timeline, **resume command built via the brain's `buildResumeCommand()`** (so it always includes `--agent` etc. — constraint #3), linked interface threads (Slack/web), notes/tags.

### 2.4 Developer persistence
Remember last workspace, last brain, favorite/pinned sessions & workspaces, saved prompt templates, filters. Stored locally (small JSON or the SQLite index) — no accounts.

## 3. Web CLI chat — start & continue in the browser

This is the core new capability: the browser becomes an Interface that runs turns through the core.

### 3.1 Start a session
A "New session" composer:
```
Brain:     [Kiro ▾]  (options from the brain registry; disabled flags hidden)
Workspace: [pick from workspace registry ▾]   (04)
Agent:     [main ▾]  (only if brain.capabilities.agents)
Model:     [… ▾]      (only if brain.capabilities.models)
Prompt:    [ textarea ]                        [ Run ]
```
Submitting builds an `IncomingMessage` (`interface:"web"`, fresh `conversationKey`) into the same core `onMessage` path Slack uses (`02` §5). The core picks the brain, runs the turn, captures the session id (failure-safe), and the browser shows the result.

### 3.2 Continue a session
On the session detail page, a "Continue here" composer sends a thread-reply-style `IncomingMessage` targeting that session's `conversationKey`. Works for any brain that supports resume; if `brain.capabilities.resume === false`, the composer is replaced by an honest "This tool doesn't support resuming — start a new session" note (never a broken button).

### 3.3 Output & liveness (no fake streaming — constraint #1)
Because brains block-buffer on a pipe, the browser shows a **run timeline of lifecycle events + elapsed time**, then the **final output** when the turn completes:
```
▸ run started (Kiro · main · opus) — 00:00
▸ working… — 00:42        (elapsed heartbeat via SSE)
▸ completed — 01:17
[ final formatted output ]
```
Delivered over **SSE** (`GET /api/runs/:id/events`) with a polling fallback. If/when a brain sets `incrementalOutput:true`, the same timeline can carry partial chunks — no UI rework needed. Do **not** build a token-stream UI that the brains can't feed.

## 4. Tool-quirk UX (the Kiro resume-lock case)

When "Continue here" targets a session, the core calls the brain's `prepareResume()` (`01` §5) first:
- **`ok`** → run normally.
- **`blocked`** (Kiro session live in another PID) → the browser shows a clear choice instead of silently producing stale replies:
  ```
  ⚠ This session is open in another live process (pid 68997).
     [ Take over (ends the other process) ]   [ Open read-only copy ]   [ Cancel ]
  ```
  "Take over" = force-takeover, which terminates the holding PID **only on this explicit click** (never automatic — destructive). Brains without `singleWriterLock` never show this. The web UI contains **no Kiro-specific code** for this — it renders whatever `prepareResume` returns (`02` keeps interfaces brain-agnostic).

## 5. Bridge/run control (cross-platform)
- Replace `kill -0`/bash-only status with the core's cross-platform process control (P0). The dashboard's start/stop/restart and status must work on Windows and macOS (constraint #6).
- Show core health: active runs, recent failures, brain availability (from `doctor`), config warnings.

## 6. Structure note (doctrine: keep it simple)
The single-file `index.html` is fine until web-chat grows it past readability. **Split only when it hurts** — extract `app.js`/`style.css` when the file crosses ~a few hundred lines of JS, not preemptively. No frontend build step; plain modules. Auth stays localhost-only (P0/`05`); warn if bound off-localhost.

## 7. Phasing (P4; needs P1 core + P2 for multi-brain)
1. Point the web UI at the **core API** instead of reading files directly (server becomes a thin core client + SSE).
2. Brain-aware unified session list + badges + `buildResumeCommand` resume strings.
3. SQLite FTS5 **derived index** + metadata search + `doctor --reindex`.
4. **New-session composer** → core `onMessage` (web Interface, `02` §5).
5. **Continue composer** + `prepareResume` quirk UX + SSE lifecycle timeline.
6. Developer persistence (favorites, last-used, templates).
7. Gate: start Kiro *and* Cline sessions from the browser; continue a resumable session; get the take-over prompt when a Kiro session is live elsewhere; search finds sessions by workspace/brain/date — all on Windows and macOS.
