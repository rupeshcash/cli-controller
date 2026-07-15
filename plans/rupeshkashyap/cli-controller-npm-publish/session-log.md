# Session Log

- Host: rupeshkashyap
- Type: analysis + release-prep
- Context: cli-controller npm next-version publish readiness
- Started: 2026-07-15T20:22 IST
- Session file: plans/rupeshkashyap/cli-controller-npm-publish/session-log.md
- Related docs: pty-headless-modes.md, publish-audit.md

## Entries

- 2026-07-15T20:24 — kiro — Diagnosed Slack bridge outage: Socket Mode connection wedged after an afternoon network flap (repeated `getaddrinfo ENOTFOUND slack.com` + ping/pong timeouts, WebSocket reconnect counter 22→36). Process alive but deaf. Restarted bridge (pid 36113 → 67555); reconnected cleanly. Flagged separate `kiro-cli` OAuth expiry needing interactive `kiro-cli login`.
- 2026-07-15T21:49 — kiro — Confirmed PTY vs headless model from code: PTY (`runKiroPty`) is a resume-only POC gated behind `KIRO_PTY_RESUME=1` (currently OFF → 100% headless). Documented in pty-headless-modes.md.
- 2026-07-15T21:49 — kiro — Publish audit: version 0.1.1 in package.json is stale vs ~14 unreleased commits since the 0.1.1 bump. PII scan of the published file set is clean; secrets gitignored and untracked. Details in publish-audit.md.
- 2026-07-15T21:49 — kiro — Rewrote README.md for readability + explicit first-time Slack app setup steps.
- 2026-07-15T22:30 — kiro — RCA'd cross-session contamination (Thread A answered from Thread B's session). Root cause: headless `runKiro` returns no sessionId, so fresh turns always fall to `captureNewSession`, which used `find(first new session in cwd)` — captures the wrong session when another is created in the same cwd during the turn window. Evidence: state.json has multiple threads sharing one sessionId + a garbage `"the"`. `kiro-cli` has no create-with-id flag. Applied strict capture (exactly-one-new + UUID validation) → contamination now impossible. Proposed per-cwd creation serialization as follow-up. Error screenshot is a separate transient Kiro backend InternalServerError. Details in rca-cross-session-contamination.md.
