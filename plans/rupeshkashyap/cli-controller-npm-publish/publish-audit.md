# Publish Readiness Audit — cli-controller-lib

> **Context**: Prepare the next npm release. Audit changes since the first publish, scan for PII in the published artifact, and list what must happen before `npm publish`.
> **Author**: rupeshcash (via kiro)
> **Created**: 2026-07-15
> **Last updated**: 2026-07-15
> **Status**: complete

## TL;DR

- `package.json` version is **0.1.1**, but roughly **14 commits of shipped work land after the 0.1.1 bump** with no further version change. The next publish needs a version bump.
- Recommended bump: **0.2.0** (multiple new user-facing features since 0.1.1 — teleport, Cline parity, plan/act, usage tracking, image uploads).
- **PII scan of the published file set is clean.** No tokens, emails, API keys, or hardcoded Slack IDs. `npm publish --dry-run` ships source only.
- Secrets (`.env`, `state.json`, `*.log`, `macos-ca.pem`, `bridge.pid`) are gitignored and untracked, so the public GitHub repo is clean too.
- No git tags exist. Tag releases going forward.

## Version state

| Item | Value |
|---|---|
| `package.json` version | 0.1.1 |
| Git tags | none |
| Commits after the `0.1.1` bump commit (`2592535`) | ~14 |
| Bump commit | `2592535 fix(windows): … bump 0.1.1` |

The 0.1.1 bump happened early. Everything after it (teleport, PTY resume POC, Cline work, plan/act, usage, image uploads, several Windows/security fixes) is unreleased under 0.1.1.

## Changes since first publish (`5af4b97`)

### Features
- **Teleport** — `!teleport <id> [brain] [force]`: pull any session (terminal or Slack) into a thread; `force` terminates a lock-holding process to take over (`40b1a4d`).
- **Cline brain functional + at parity with Kiro** — routes from Slack, `!recent` aggregates all brains, broker gates on Kiro availability so it can still route to Cline (`251308b`, `6d33d91`).
- **Plan/Act mode for Cline** — sticky per-thread, maps to `-p`; plus `!usage` and an automatic per-turn tokens/cost/model footer; brain-aware `!help` (`8fb9652`).
- **Interactive PTY resume (POC, optional)** — `node-pty` rehydrates TUI/subagent sessions headless resume can't (Kiro#9066); clean answer captured via `/transcript` export. Gated behind `KIRO_PTY_RESUME=1` (`ecce4f0`, `8bd371f`).
- **Slack attachment forwarding** — image + text-snippet uploads forwarded to the brain (image-capable brains only) (`e6a4570`).

### Fixes
- **Security (CodeQL js/shell-command-injection-from-environment)** — stop passing a PATH-derived absolute path to `spawn`; let the OS resolve the bare command (`569fb92`).
- **Windows spawn hardening** — `cross-spawn` for npm `.cmd` shims (Cline arg escaping), `ComSpec` full `cmd.exe` path, guard non-existent cwd, `windowsHide`, gate `detached` to POSIX (`483a291`, `1019af3`, `a214b45`, `2592535`).
- **NL router no longer corrupts Windows paths** (spawn ENOENT) (`d53bc75`).
- **Resume safety** — don't run context-less turns against a session locked by another process (`6821f07`).
- **TLS-inspecting proxy** — provision OS/corporate CA trust on start so installs work behind a corporate MITM proxy (`f7c1ed4`).

### Packaging / chore
- Added `bugs`, `homepage`, `prepublishOnly` test hook (`5312a4e`).
- Boot-time logging of resolved default brain + broker state (`8c35de0`).

## PII / secrets audit (published file set)

Scanned the exact `files` allowlist: `bin/ lib/ core/ slack-bridge/src/ run.sh doctor.js .env.example web-ui/server.js web-ui/public/ README.md LICENSE`.

| Check | Result |
|---|---|
| Real Slack tokens (`xoxb-`/`xapp-`, non-placeholder) | none |
| Emails | none |
| API keys (`sntryu_`, `sk-`, `AKIA`, `gh[pousr]_`) | none |
| Hardcoded Slack IDs (`U0…`/`D0…`/`C0…`) | none |
| Personal absolute paths (`/Users/<name>`) | one benign example string in a broker prompt (`"C:/Users/you/proj"`), not personal |
| `rupesh` / `armorcode` personal refs | none (only the public `rupeshcash` GitHub handle) |

`npm publish --dry-run` tarball = source only. Excluded and confirmed absent: `.env`, `state.json`, `bridge.log`, `macos-ca.pem`, `bridge.pid`, `plans/`, tests.

**Directly observed** (grep + `npm publish --dry-run` output). Not inferred.

Secrets are also gitignored (`**/.env`, `**/state.json`, `**/*.log`, `**/macos-ca.pem`, `**/*.pid`) and `git ls-files` confirms none are tracked, so the public GitHub repo is clean.

## Pre-publish checklist

- [ ] **Bump version** in `package.json` (recommend `0.2.0`).
- [ ] Update `CHANGELOG.md` for 0.2.0 (it exists but is not in `files`, so GitHub-only).
- [ ] Update `README.md` (done — readability + first-time Slack steps).
- [ ] `npm test` green (also runs automatically via `prepublishOnly`).
- [ ] `npm publish --dry-run` — reconfirm file list.
- [ ] `git tag v0.2.0 && git push --tags` after publish.
- [x] PII / secrets scan of published set — clean.
- [x] `optionalDependencies.node-pty` — correct placement (native dep won't break installs where it can't build).

## References

- `package.json` — version, `files`, `prepublishOnly`
- `git log 5af4b97..HEAD` — change history
- `.gitignore`, `slack-bridge/.gitignore` — secret exclusion
