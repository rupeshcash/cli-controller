# Contributing

Local-first, single-user, zero-infra tool. The guiding doctrine: **when individual-developer UX and extensibility conflict, UX wins.** Keep it simple; extend only as far as a concrete need requires.

## Setup

```bash
git clone git@github.com:rupeshcash/cli-controller.git && cd cli-controller
npm install                 # root deps (bridge + panel share them)
npm test                    # node:test suite
node bin/cli-controller.js status
```

## Add a Brain (a new AI CLI — e.g. Claude Code, Codex)

One file + one registry line. Implement the contract in [`core/brain/kiro.js`](core/brain/kiro.js) / [`core/brain/cline.js`](core/brain/cline.js):

1. Create `core/brain/<tool>.js` exporting an `adapter` with: `id`, `displayName`, `capabilities` (resume/agents/models/sessionStore/singleWriterLock/incrementalOutput), `runTurn`, `listSessions`, `prepareResume`, `buildResumeCommand`, `doctor` (+ optional `listAgents`/`listModels`/`recentSessions`).
2. Register it in [`core/brain/index.js`](core/brain/index.js).
3. Add unit tests (see `slack-bridge/test/cline.test.js`). Interfaces/web must contain **no `if (brain === 'x')`** — all divergence lives behind capabilities/hooks.

## Add an Interface (Telegram, REST, …)

The core is interface-agnostic (`core/runner.js`, `core/brain`, `core/memory`). A new interface is a thin transport that turns its messages into `runner.runTurn(...)` calls and renders results back — model it on `slack-bridge/` and `web-ui/`. **Do not** add WhatsApp via unofficial libraries (account-ban risk; the project rejected it — see `evaluation.md`).

## Rules

- Match the existing style. **One-line comments only** — no essay comments; rationale goes in `plans/architecture/`.
- Every behavior change gets a test. `npm test` must stay green.
- Never weaken the security defaults in `SECURITY.md`.
- Native modules are avoided (they break on Node upgrades — the reason node-pty was rejected). Prefer built-ins / pure JS.
- Keep `plans/architecture/architecture.md` (the single source of truth) in sync with any architectural change.
