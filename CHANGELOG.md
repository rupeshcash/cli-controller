# Changelog

All notable changes to this project. Format loosely follows Keep a Changelog; versions are semver.

## [Unreleased]

## [0.2.0] - 2026-07-15

### Added
- **`cli-controller` binary** — cross-platform front door (setup / start / stop / restart / status / doctor, plus per-service `bridge`/`panel` control) with pure-Node process lifecycle (no bash, works on Windows/macOS/Linux).
- **Natural-language onboarding wizard** (`cli-controller setup`) — detects the AI brain, walks through Slack tokens, validates via `auth.test`, sets the allow-list to just you, starts the services, and hands off to chat-driven onboarding.
- **Manager memory** (`core/memory`) — ever-persistent, cross-session, searchable store (append-only JSONL, zero deps, cross-process). Captured on every turn; surfaced via Slack `!recall` and web `/api/memory/{search,recent}`. Backend-swappable.
- **`!` = manager** — inside a live thread, `!<natural language>` is routed to the manager and classified into an admin action (switch brain/model/agent, verbose, abort, end, clear, recall, recent). Fast commands (`!abort`, `!status`, `!end`) stay deterministic and LLM-free.
- **Multi-brain, Cline at parity with Kiro** — Cline is fully functional from Slack behind the `core/brain` adapter contract. `!recent` and admin recent aggregate all brains (tagged, teleport-with-brain), and the NL broker gates on Kiro availability so it can route to Cline regardless of default brain. Per-session selection via `!new brain=` or NL routing.
- **Plan/Act mode (Cline)** — sticky per-thread, maps to Cline's `-p`. Plus `!usage` and an automatic per-turn footer showing tokens / cost / model, and brain-aware `!help` and control lists (same verbs everywhere, capability-gated per brain).
- **Interactive PTY resume (POC, opt-in)** — `node-pty` (optional dependency) drives the real Kiro TUI to rehydrate TUI/subagent sessions that headless `--resume-id` cannot reconstruct (Kiro#9066), capturing a clean answer via Kiro's own `/transcript save --json`. Gated behind `KIRO_PTY_RESUME=1`. Off by default (headless remains the default path).
- **Teleport** — `!teleport <id> [brain] [force]` pulls any session (terminal or Slack, any brain) into the current thread. `force` terminates a lock-holding process to take over.
- **Slack attachment forwarding** — image and text-snippet uploads are forwarded to the brain (images only for image-capable brains, e.g. Kiro).
- **Web cockpit** — brain-aware session tracking, in-browser chat (start/continue via `core/runner`), SSE run timeline, Kiro resume-lock surfacing.
- **Slack channel support** — `@mention` to start, thread reply to continue, allow-list enforced.
- **Stabilization** — cross-platform bridge status, startup config validation + safety warnings, `doctor`, and a `node:test` suite (53 tests).

### Security
- Safe defaults: self-only allow-list, opt-in tool trust, `127.0.0.1`-only cockpit, secrets in a 0600 `.env`, stdin-fed prompts, no-shell spawns. See `SECURITY.md`.
- **Removed a shell-command-injection vector** (CodeQL `js/shell-command-injection-from-environment`): the launcher no longer feeds a PATH-derived absolute path into `spawn`. POSIX lets the OS resolve the bare command; Windows routes through `cmd.exe` via `PATHEXT`. `resolveCommand` is retained for display only.

### Fixed
- **Windows paths from the NL router no longer corrupt the cwd.** The broker's LLM returned Windows paths with single backslashes (`C:\Users\dev\proj`), which `JSON.parse` either rejected or silently mangled (`\r`→CR → `C:Usersdev…`), so the brain spawned in a nonexistent dir and failed with `spawn cmd.exe ENOENT`. The router prompt now requires forward-slash paths, `extractJson` parses both the raw and a backslash-repaired copy and keeps whichever yields a cwd free of control characters, and the resolved cwd is normalized to forward slashes. Covered by `slack-bridge/test/broker.test.js`.
- **Windows `cmd.exe` spawn hardening** — use `cross-spawn` to launch npm `.cmd` shims with correct arg escaping (fixes Cline "Unknown command or unquoted prompt" where the prompt was mangled through Node→cmd.exe), use `ComSpec` (full `cmd.exe` path), and guard against a non-existent cwd by falling back to the home dir with a warning instead of hard-failing.
- **Resume ran context-less against a locked session** — continuing a teleported/resumed session held by another live process silently ran a turn Kiro couldn't attach to. The bridge now refuses to resume a session held by a live process and points to `!teleport <id> force`. A stale lock (dead owner) is auto-cleared before resume so it attaches to the real session instead of forking a fresh one.

### Changed
- Boot logs now report the resolved default brain and broker state, to make default-brain config vs stale-session issues easier to diagnose.

## [0.1.1]

### Added
- **`!teleport <id> force`** — take over a session that's open in another process (terminal/TUI). Force terminates the lock-holding process and clears the stale lock, so the session can be resumed in Slack. Without `force`, teleport warns and tells you the exact take-over command instead of just "close it there first".

### Fixed
- **Windows:** Kiro turns from the bridge failed with `The handle is invalid. (os error 6)` — the child was spawned `detached`, which strips console/std handles on Windows, so `kiro-cli` died before a session was created. `detached` is now POSIX-only (still powers `!abort` group-kill on macOS/Linux); Windows spawns with `windowsHide` instead. No behavior change on macOS/Linux.
- **Corporate TLS proxies:** a fresh `npm i -g` had no `macos-ca.pem`, so the bridge died on the Slack Socket Mode handshake with `unable to get local issuer certificate`. The `cli-controller` binary now provisions OS/corporate CA trust on start (macOS: exports the system keychains to a PEM; all platforms: `--use-system-ca` when the Node version supports it) — best-effort and never blocks startup.
- **Resume ran context-less against a locked session** — continuing a teleported/resumed session that was open in another process silently ran a turn Kiro couldn't attach to (so it ignored that session's history — "out of the loop"). The bridge now refuses to resume a session held by a *live* process and points you to `!teleport <id> force`; a *stale* lock (dead owner) is auto-cleared before resume so it attaches to the real session instead of forking a fresh one.

## [0.1.0]
- Initial Slack↔Kiro bridge + web control panel.
