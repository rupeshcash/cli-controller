# Changelog

All notable changes to this project. Format loosely follows Keep a Changelog; versions are semver.

## [Unreleased]

### Added
- **`cli-controller` binary** — cross-platform front door (setup / start / stop / restart / status / doctor, plus per-service `bridge`/`panel` control) with pure-Node process lifecycle (no bash, works on Windows/macOS/Linux).
- **Natural-language onboarding wizard** (`cli-controller setup`) — detects the AI brain, walks through Slack tokens, validates via `auth.test`, sets the allow-list to just you, starts the services, and hands off to chat-driven onboarding.
- **Manager memory** (`core/memory`) — ever-persistent, cross-session, searchable store (append-only JSONL, zero deps, cross-process). Captured on every turn; surfaced via Slack `!recall` and web `/api/memory/{search,recent}`. Backend-swappable (ai-memory pluggable later).
- **`!` = manager** — inside a live thread, `!<natural language>` is routed to the manager and classified into an admin action (switch brain/model/agent, verbose, abort, end, clear, recall, recent); fast commands stay deterministic.
- **Multi-brain** — Cline added alongside Kiro behind a `core/brain` adapter contract; per-session brain selection (`!new brain=`, NL routing).
- **Web cockpit** — brain-aware session tracking, in-browser chat (start/continue via `core/runner`), SSE run timeline, Kiro resume-lock surfacing.
- **Slack channel support** — `@mention` to start, thread reply to continue, allow-list enforced.
- **Stabilization** — cross-platform bridge status, startup config validation + safety warnings, `doctor`, and a `node:test` suite (39 tests).

### Security
- Safe defaults: self-only allow-list, opt-in tool trust, `127.0.0.1`-only cockpit, secrets in a 0600 `.env`, stdin-fed prompts, no-shell spawns. See `SECURITY.md`.

## [0.1.1]

### Fixed
- **Windows:** Kiro turns from the bridge failed with `The handle is invalid. (os error 6)` — the child was spawned `detached`, which strips console/std handles on Windows, so `kiro-cli` died before a session was created. `detached` is now POSIX-only (still powers `!abort` group-kill on macOS/Linux); Windows spawns with `windowsHide` instead. No behavior change on macOS/Linux.
- **Corporate TLS proxies:** a fresh `npm i -g` had no `macos-ca.pem`, so the bridge died on the Slack Socket Mode handshake with `unable to get local issuer certificate`. The `cli-controller` binary now provisions OS/corporate CA trust on start (macOS: exports the system keychains to a PEM; all platforms: `--use-system-ca` when the Node version supports it) — best-effort and never blocks startup.

## [0.1.0]
- Initial Slack↔Kiro bridge + web control panel.
