# Session Lifecycle & Memory — how the bridge actually works

Accurate to the current code (`src/index.js`, `src/kiro.js`, `src/sessions.js`). Read this before changing session logic.

## The core idea in one sentence

The bridge is **stateless per message** except for a small **pointer** (which Kiro session each Slack DM is on). The *actual conversation memory* lives in **Kiro's own session store**, and each message spawns a **fresh `kiro-cli` process** that reloads that history via `--resume-id`, runs one turn, persists, and exits.

## Three layers of state

| Layer | Where | What it holds | Survives bridge restart? |
|---|---|---|---|
| **1. Bridge pointer** | `state.json` (this folder), keyed by **Slack thread** (`channel:rootTs`) | `{ cwd, agent, model, sessionId }` — *which* Kiro session this thread is on | ✅ yes (on disk) |
| **2. Kiro conversation memory** | Kiro's session store on disk (per working directory, "v2"), keyed by `sessionId` | The full message history (grows with `messageCount`) | ✅ yes (Kiro owns it) |
| **3. In-flight** | `running` Map (in memory) | The child process for the current turn (for `!abort` + one-at-a-time) | ❌ no (cleared on restart) |

There is **no** conversation buffer inside the bridge. It never holds your history — it only remembers a session ID and hands it to Kiro.

## What happens on each message

```mermaid
flowchart TD
  A[Slack DM message] --> B{DM? not a bot? not an edit?}
  B -- no --> Z[ignore]
  B -- yes --> C{allowed user? (allow-all now)}
  C -- no --> Z
  C -- yes --> D{text starts with '!'?}
  D -- yes --> E[COMMAND: mutate state.json\n(cwd / agent / model / sessionId)]
  D -- no --> F{already running for this DM?}
  F -- yes --> G[reject: use !abort]
  F -- no --> H[read pointer: cwd, agent, model, sessionId]
  H --> I[wasFresh = sessionId is null]
  I --> J[spawn ONE kiro-cli process:\nkiro-cli chat --no-interactive\n[--resume-id sessionId] [--agent] [--model]\n--trust-tools=ALL  &quot;prompt&quot;]
  J --> K[Kiro loads history for sessionId,\nruns one turn, PERSISTS, exits]
  K --> L{wasFresh?}
  L -- yes --> M[capture new sessionId\n= newest session in cwd\n→ save to state.json]
  L -- no --> N[keep same sessionId]
  M --> O[clean ANSI + chunk output → Slack]
  N --> O
```

### Turn-by-turn

- **First message in a DM** (`sessionId` is null): runs Kiro with **no** `--resume-id` → Kiro **creates** a session. After it exits, the bridge captures that session's id (currently: "newest session in this `cwd`") and stores it.
- **Every later message**: runs with `--resume-id <sessionId>` → Kiro **reloads** the full prior conversation, appends this turn, persists, exits. That's your continuity.
- **`!new`**: sets `sessionId = null` → next message starts a brand-new Kiro session (fresh memory).
- **`!use <id>`**: sets `sessionId` → next message resumes that specific session.
- **`!cd <path>` / `!agent <name>`**: resets `sessionId` (a new dir/agent = a new context), mirroring relaunching `kiro-cli chat` in that dir/agent.

### Continuity across restarts
Because the pointer is in `state.json` and Kiro's history is on disk, restarting the bridge **does not** lose your conversations — the same DM keeps talking to the same Kiro session.

## Scope rules (important)

- A session is effectively scoped to **(Slack DM) → (sessionId in a cwd)**. One **active** session per DM at a time.
- Kiro scopes sessions **per working directory**. `!sessions` lists sessions for the current `cwd`; `!cd` changes which set you see and resets the active one.
- Multiple DMs (or multiple users, since allow-all) run **independently** — each spawns its own process.

## ⚠️ Weak spots (be honest — these matter for "super clean")

1. ~~**Fresh-session capture is a heuristic.**~~ **✅ Fixed.** The bridge now snapshots the session-id set *before* a fresh run and picks the id that's *new* afterward (set difference) — robust regardless of timing/ordering.

2. ~~**No fallback if a stored `sessionId` goes stale.**~~ **✅ Fixed.** On a resume failure, the bridge auto-retries once as a fresh session and tells you in-thread.

3. ~~**One active session per DM.**~~ **✅ Solved by thread = session.** Each top-level `!new` opens its own thread/session; threads run independently (and in parallel). Continue a session by replying in its thread.

4. **Per-turn timeout** can kill a long autonomous run mid-way; the partial turn may or may not be persisted cleanly. → **Configurable** via `KIRO_TIMEOUT_MS` (default 5 min; `0` = no timeout).

5. **Unbounded context growth.** A long session reloads an ever-larger history each turn → slower/costlier over time. Use `!new` to reset. (Kiro may do its own context management; the bridge doesn't compact.)

6. **No live streaming.** Output is sent after the turn completes (chunked), not token-by-token — a consequence of the spawn-per-turn model (which is what makes it robust and restart-safe).

## Recommended hardening (cheap, high-value)

- **#1 reliable session capture** (before/after set-diff) — removes the only real correctness risk.
- **#2 resume-failure fallback** — makes it self-healing.

Both are small, local changes with no downside. Optional extras: configurable/removable timeout, a `!compact`/`!new` reminder on long sessions, per-DM isolation if you ever go multi-user.
