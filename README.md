# cli-controller

Drive AI coding agents from **Slack** (or a local **web cockpit**) — from your phone, without SSH. Pick a **brain** (Kiro or Cline today; Claude Code / Codex later), talk to it in a thread, and let a **manager** handle sessions, routing, and memory on your behalf. Local-first, single-user, no server.

```
you (phone) ──▶ Slack thread ──▶ manager ──▶ Kiro / Cline on your machine ──▶ reply in the thread
```

## Why

Nothing beats "make a thread and ask" for controlling a long-running coding agent while you're away from the keyboard. This wraps that into a safe, local tool: Slack's official **Socket Mode** (no public URL, no port-forwarding, no account-ban risk — unlike unofficial WhatsApp libs; see [`evaluation.md`](evaluation.md)).

## One-minute install

```bash
npm install -g cli-controller-lib      # (or: npx cli-controller-lib setup)
cli-controller                         # first run → guided setup wizard
```

The wizard, in plain language: detects your AI brain (Kiro/Cline) → walks you through the two Slack tokens → sets the allow-list to **just you** → starts the bridge + cockpit → tells you to go DM your bot. Prereqs: **Node ≥ 18** and at least one brain CLI on your PATH.

```bash
cli-controller start | stop | restart | status | doctor
cli-controller bridge <cmd>            # Slack bridge only
cli-controller panel  <cmd>            # web cockpit only (http://localhost:1234)
```

## How it works

- **Thread = session.** Send a message → the *manager* routes it (which repo, brain, agent, model) and opens a session in a Slack thread; reply in the thread to continue. Each new top-level message is a separate, parallel session.
- **`!` talks to the manager, bare text talks to the agent.** Inside a live thread, a plain reply goes to the coding agent; `!<anything>` summons the manager in natural language — `!use cline`, `!switch to opus`, `!abort`, `!recall the auth bug session`. Fast commands (`!abort`, `!status`, `!end`) stay instant and LLM-free.
- **Multi-brain.** Kiro and Cline today, behind one adapter contract — adding a brain is one file. Choose per session.
- **Persistent manager memory.** Every turn is captured to an ever-persistent local store; the manager can search and cross-reference past sessions (`!recall`, or the cockpit's `/api/memory`).
- **Web cockpit.** Browse/search/filter every session (terminal *and* Slack), start & continue sessions in the browser, control the bridge — on `localhost:1234`.
- **Channels too.** `@mention` the bot to start in a channel; reply in-thread to continue. The allow-list still gates who can run code.

## Cline support

Install and configure the Cline CLI separately, then either make it the default brain or choose it per Slack session:

```bash
npm i -g cline
cli-controller doctor
```

```env
CLI_CONTROLLER_DEFAULT_BRAIN=cline
CLINE_BIN=cline
```

Per-session from Slack:

```text
!new brain=cline dir=~/projects/myrepo provider=anthropic model=claude-sonnet-4 fix the failing tests
```

Inside a thread, `!provider <name>` and `!model <name>` apply to the next turn.

## Security

This is **remote code execution on your own machine, by design.** Safe defaults are enforced: the wizard sets `SLACK_ALLOWED_USER_IDS` to just you (never `*` on shared workspaces), tool-trust is opt-in, and the web cockpit binds to `127.0.0.1`. `cli-controller doctor` warns on risky combinations. See [`SECURITY.md`](SECURITY.md).

## Architecture

Single source of truth: [`plans/architecture/architecture.md`](plans/architecture/architecture.md) (compact, current). Layered: **Interfaces** (Slack, web) → **Manager/Orchestrator** → **core** (runner, brain registry, memory) → **Brains** (Kiro, Cline). Memory design + the manager model: [`plans/architecture/arch_2_sequence.md`](plans/architecture/arch_2_sequence.md).

## Development

```bash
npm test         # node:test — core (brain, memory, runner), libs (lifecycle, config), parsing
```

Contributing (add a brain / an interface): [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
