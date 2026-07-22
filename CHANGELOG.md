# Changelog

All notable changes to this project. Format loosely follows Keep a Changelog; versions are semver.

## [Unreleased]

### Added
- **Terminal-resume command surfacing** — when a Slack session starts, the bridge posts a copyable command to resume that exact session in your terminal; also shown in `!status`. Built from each brain's own `buildResumeCommand` (brain-agnostic; Kiro includes `--agent`). The command only exists after the first turn creates the session id, so it posts then (open-session messages point at `!status`). Tracked Cline concurrency gap in `plans/tickets.md` (CLI-TELE-1).
- **`cli-controller` binary** — cross-platform front door (setup / start / stop / restart / status / doctor, plus per-service `bridge`/`panel` control) with pure-Node process lifecycle (no bash, works on Windows/macOS/Linux).
- **Natural-language onboarding wizard** (`cli-controller setup`) — detects the AI brain, walks through Slack tokens, validates via `auth.test`, sets the allow-list to just you, starts the services, and hands off to chat-driven onboarding.
- **Controller memory** (`core/memory`) — ever-persistent, cross-session, searchable store (append-only JSONL, zero deps, cross-process). Captured on every turn; surfaced via Slack `!recall` and web `/api/memory/{search,recent}`. Backend-swappable (ai-memory pluggable later).
- **`!` = controller** — inside a live thread, `!<natural language>` is routed to the controller and classified into an admin action (switch brain/model/agent, verbose, abort, end, clear, recall, recent); fast commands stay deterministic.
- **Multi-brain** — Cline added alongside Kiro behind a `core/brain` adapter contract; per-session brain selection (`!new brain=`, NL routing).
- **Web cockpit** — brain-aware session tracking, in-browser chat (start/continue via `core/runner`), SSE run timeline, Kiro resume-lock surfacing.
- **Slack channel support** — `@mention` to start, thread reply to continue, allow-list enforced.
- **Stabilization** — cross-platform bridge status, startup config validation + safety warnings, `doctor`, and a `node:test` suite (39 tests).

### Security
- Safe defaults: self-only allow-list, opt-in tool trust, `127.0.0.1`-only cockpit, secrets in a 0600 `.env`, stdin-fed prompts, no-shell spawns. See `SECURITY.md`.

### Fixed
- **Threads no longer forget their session** ("This thread has no session"). Two causes fixed: (1) `state.json` was written non-atomically and, on a parse error at boot, silently reset to `{}` — a crash/restart mid-write wiped *every* thread at once. Writes are now atomic (temp file + `rename`) with a `.bak` snapshot, and load falls back to the backup instead of discarding non-empty state. (2) A thread that lost its session dead-ended the user. The bridge now recovers the session from the durable append-only memory log (`threadKey → session`, which survives a `state.json` wipe); if the thread is genuinely unknown it continues as a fresh session in the same thread instead of telling the user to start over. Memory now also records the session's `agent` so recovery resumes with the right agent. Covered by `slack-bridge/test/sessions.test.js`.

## [0.1.1]

### Added
- **`!teleport <id> force`** — take over a session that's open in another process (terminal/TUI). Force terminates the lock-holding process and clears the stale lock, so the session can be resumed in Slack. Without `force`, teleport warns and tells you the exact take-over command instead of just "close it there first".

### Fixed
- **Windows:** Kiro turns from the bridge failed with `The handle is invalid. (os error 6)` — the child was spawned `detached`, which strips console/std handles on Windows, so `kiro-cli` died before a session was created. `detached` is now POSIX-only (still powers `!abort` group-kill on macOS/Linux); Windows spawns with `windowsHide` instead. No behavior change on macOS/Linux.
- **Corporate TLS proxies:** a fresh `npm i -g` had no `macos-ca.pem`, so the bridge died on the Slack Socket Mode handshake with `unable to get local issuer certificate`. The `cli-controller` binary now provisions OS/corporate CA trust on start (macOS: exports the system keychains to a PEM; all platforms: `--use-system-ca` when the Node version supports it) — best-effort and never blocks startup.
- **Resume ran context-less against a locked session** — continuing a teleported/resumed session that was open in another process silently ran a turn Kiro couldn't attach to (so it ignored that session's history — "out of the loop"). The bridge now refuses to resume a session held by a *live* process and points you to `!teleport <id> force`; a *stale* lock (dead owner) is auto-cleared before resume so it attaches to the real session instead of forking a fresh one.

## [0.1.0]
- Initial Slack↔Kiro bridge + web control panel.
