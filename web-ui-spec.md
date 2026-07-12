# Kiro Control Panel — Web UI Spec

> **Goal:** One place for all Kiro management. See every session (Slack or terminal), control the bridge, navigate history — from a sleek web UI on `localhost:1234`.

## What this is

A lightweight **local** web dashboard that:
1. Shows ALL Kiro sessions (terminal + Slack bridge) in one unified, categorized view
2. Controls the Slack bridge (start / stop / restart / status / logs)
3. Lets you copy a one-liner to resume any session in your terminal
4. Shows context usage % per session (the `◕ NN%` the TUI shows)

No auth needed — it runs on localhost only.

---

## Pages

### 1. Dashboard (`/`)

At a glance:
- Bridge status card: 🟢 Running / 🔴 Stopped + start/stop/restart buttons
- Quick stats: total sessions, active Slack threads, sessions today
- Recent activity (last 5 sessions across both sources)

### 2. Sessions (`/sessions`)

Unified list of ALL 280+ Kiro sessions from `~/.kiro/sessions/cli/`.

**Columns:**
| Column | Source |
|---|---|
| Title (truncated) | `.json → title` |
| Agent | `.json → session_state.agent_name` |
| Directory | `.json → cwd` (show basename, full on hover) |
| Source | `🖥️ Terminal` or `💬 Slack` (if sessionId appears in bridge `state.json`) |
| Context % | `.json → session_state.rts_model_state.context_usage_percentage` |
| Messages | count from `.jsonl` lines |
| Last active | `.json → updated_at` (relative: "2h ago") |
| Resume command | Copy button → `kiro-cli chat --resume-id <id>` |

**Filters / sort:**
- Source: All / Terminal / Slack
- Agent: dropdown (main, default, kiro_planner, etc.)
- Directory: group by project / flat
- Sort: last active (default), created, message count, context %

**Search:** full-text on title.

### 3. Session Detail (`/sessions/:id`)

- Full title
- Metadata card: agent, model, cwd, context %, message count, created/updated, source
- Resume command (copy button): `cd <cwd> && kiro-cli chat --resume-id <id>`
- If Slack-sourced: show which thread (timestamp, link if possible)
- Conversation preview: first + last 5 messages (from `.jsonl`)

### 4. Bridge (`/bridge`)

- Status: running/stopped + PID + uptime
- Buttons: Start / Stop / Restart
- Active Slack threads table (from `state.json`): thread key, session ID, cwd, agent
- Live log viewer (last 100 lines of `bridge.log`, auto-refresh)
- Config display (from `.env`, secrets masked)

---

## Tech stack (fast + no-nonsense)

| Layer | Choice | Why |
|---|---|---|
| Server | **Express** (already have Node in the project) | Zero new runtime |
| Frontend | **Vanilla HTML + htmx** (or a single static React SPA) | Instant load, no build step |
| Session data | Read `~/.kiro/sessions/cli/*.json` on demand | No DB, no sync, always fresh |
| Bridge control | Shell out to `./bridge start\|stop\|restart\|status` | Reuse existing script |
| Logs | `tail -n 100 bridge.log` | Simple |
| Port | `1234` (configurable) | As requested |

**No database. No build step. No external dependencies beyond Express.**

Alternative: if you want something even snappier with nice styling out of the box, we could use **Hono** (8KB, fast) + **Pico CSS** (classless pretty HTML). But Express is already a dep of Bolt (same project), so zero new installs.

---

## API (server → frontend)

```
GET  /api/status              → { bridge: "running"|"stopped", pid, uptime, threads: N, sessions: N }
POST /api/bridge/start        → { ok, pid }
POST /api/bridge/stop         → { ok }
POST /api/bridge/restart      → { ok, pid }
GET  /api/bridge/logs?n=100   → { lines: [...] }
GET  /api/bridge/threads      → [{ key, sessionId, cwd, agent, verbose }]
GET  /api/sessions?source=&agent=&sort=&q=  → [{ id, title, agent, cwd, source, contextPct, messages, updatedAt }]
GET  /api/sessions/:id        → { ...full detail + first/last messages }
```

---

## File structure

```
cli-controller/
  slack-bridge/          ← existing bridge (untouched)
  web-ui/
    server.js            ← Express, serves API + static
    public/
      index.html         ← dashboard
      sessions.html      ← session list
      session.html       ← session detail
      bridge.html        ← bridge control
      style.css          ← one stylesheet (Pico CSS or minimal custom)
      app.js             ← htmx or vanilla fetch calls
    package.json
```

---

## Session source detection

A session is "from Slack" if its `session_id` appears as a `sessionId` value in `slack-bridge/state.json`. Everything else is "Terminal". Simple set lookup.

---

## Resume command format

For any session:
```bash
cd /path/to/cwd && kiro-cli chat --resume-id <session_id>
```
Displayed as a code block with a 📋 copy button.

---

## Non-goals (MVP)

- No session deletion from the UI
- No real-time message streaming (just a snapshot)
- No remote access (localhost only)
- No auth (single-user machine)
- No editing bridge config from the UI (edit `.env` directly)

---

## Implementation order

1. `server.js` — Express + API endpoints (read session JSONs + bridge control)
2. `public/` — static HTML pages with fetch-based data loading
3. Wire to port 1234, test end-to-end
4. Add `./panel` script (like `./bridge`) for one-command start/stop

---

## Success criteria

1. Open `localhost:1234` → see bridge status + recent sessions
2. Click Sessions → unified list of all 280 sessions, filterable by source/agent/dir
3. Click a session → see detail + copy resume command
4. Bridge page → start/stop/restart buttons work; live log tail
5. < 3s page load on 280 sessions
