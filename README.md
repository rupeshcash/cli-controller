# cli-controller

Drive AI coding agents from **Slack** or a local **web cockpit**, straight from your phone, no SSH. Start a thread, tell it what to do, and a local manager routes the work to a coding CLI (Kiro or Cline today) running on your own machine. Local-first, single-user, no server.

```mermaid
flowchart LR
    A["You (phone / desktop)"] --> B["Slack thread"]
    B --> C["Manager (routing + memory)"]
    C --> D["Kiro / Cline on your machine"]
    D --> B
```

Slack's official **Socket Mode** makes this safe: the bot opens an outbound WebSocket, so there is no public URL, no port forwarding, and no account-ban risk that unofficial chat bridges carry (background in [`evaluation.md`](evaluation.md)).

---

## What you can do

- **Thread = session.** Each top-level message opens its own session in a thread. Reply in the thread to continue that session. Different threads run in parallel.
- **Talk normally, or command with `!`.** A plain reply goes to the coding agent. A message starting with `!` talks to the manager: `!use cline`, `!model opus`, `!abort`, `!recall the auth bug`. Fast commands (`!abort`, `!status`, `!end`) skip the LLM and run instantly.
- **Pick a brain per session.** Kiro and Cline today, behind one adapter. Adding a brain is a single file.
- **Persistent memory.** Every turn is saved locally. The manager can search and cross-reference past sessions with `!recall` or the cockpit.
- **Web cockpit.** Browse, search, and filter every session (terminal and Slack), start or continue sessions in the browser, and control the bridge at `http://localhost:1234`.
- **Channels, not only DMs.** `@mention` the bot to start in a channel and reply in-thread to continue. The allow-list still controls who can run code.

---

## First-time setup

Two things run on your machine: the **Slack bridge** and the **web cockpit**. You need a Slack app (about 5 minutes) and one coding CLI on your PATH.

### Prerequisites

- **Node.js 18+** (`node -v`)
- At least one brain CLI installed and authenticated:
  - Kiro: `kiro-cli chat --list-models` should succeed
  - Cline: `npm i -g cline`

### Step 1 — Create the Slack app

> **On a work laptop and can't add apps to the company workspace?** Create a free personal Slack workspace, build the app there, and add that workspace to the Slack client you already use. You will DM the bot in your personal workspace, so no corporate admin is needed.

1. Open **https://api.slack.com/apps** and choose **Create New App → From scratch**. Name it (for example `Kiro Bridge`) and pick your workspace.
2. **Socket Mode** (left sidebar) → turn **Enable Socket Mode** on. When prompted, create an **App-Level Token** with the `connections:write` scope. Copy it. This is your **`SLACK_APP_TOKEN`** (starts with `xapp-`).
3. **OAuth & Permissions → Bot Token Scopes** → add:
   - `chat:write`
   - `im:history`, `im:read`, `im:write`
   - `files:write` (uploads long output as a file snippet)
   - `reactions:write` (optional, enables the ⏳ / ✅ / ❌ status reactions)
4. **Event Subscriptions** → turn **Enable Events** on → under **Subscribe to bot events** add `message.im`. Socket Mode delivers these over the WebSocket, so no Request URL is needed.
5. **App Home → Show Tabs** → enable the **Messages Tab** and check **"Allow users to send Slash commands and messages from the messages tab."**
6. **Install App → Install to Workspace** and approve. Copy the **Bot User OAuth Token**. This is your **`SLACK_BOT_TOKEN`** (starts with `xoxb-`).
7. Get your own Slack member ID: profile → **⋮ (More) → Copy member ID** (starts with `U`).

> Want to drive the bot from channels too? See the channel scopes and events in [`slack-bridge/SETUP.md`](slack-bridge/SETUP.md).

### Step 2 — Install and configure

```bash
npm install -g cli-controller-lib
cli-controller                 # first run launches the setup wizard
```

The wizard detects your brain, captures and validates the two Slack tokens, sets the allow-list to just you, writes the config, and offers to start the bridge and cockpit. When it finishes, open Slack and DM your bot.

Prefer to configure by hand? Copy `slack-bridge/.env.example` to `slack-bridge/.env` and fill in:

```
SLACK_BOT_TOKEN=xoxb-...        # step 6 (Bot User OAuth Token)
SLACK_APP_TOKEN=xapp-...        # step 2 (App-Level Token, Socket Mode)
SLACK_ALLOWED_USER_IDS=U0XXXX   # step 7 (your member ID, comma-separate for more)
KIRO_DEFAULT_CWD=/path/to/repo  # the directory the agent works in
KIRO_TRUST_TOOLS=fs_read        # read-only, the safe default
```

`.env` is gitignored, so your tokens are never committed.

### Step 3 — Run it

```bash
cli-controller start           # bridge + cockpit
cli-controller status
```

Open Slack, DM your bot, and try:

```
!help
Summarize the README in this repo.
```

---

## Everyday commands

| In a thread | What it does |
|---|---|
| plain text | Sent to the coding agent as a prompt |
| `!abort` | Stop the current run |
| `!status` / `!peek` | Session info, or elapsed time if a turn is running |
| `!model <name>` | Set the model for the next turn |
| `!agent <name>` | Set the agent / context profile |
| `!use <brain>` | Switch brain (`kiro` / `cline`) |
| `!end` | Close the session |

| Anywhere | What it does |
|---|---|
| plain top-level message | Manager routes it and opens a new session |
| `!new [dir=… model=… agent=…] <task>` | Start an explicit session, skip routing |
| `!recent [n]` | Recent sessions across all brains (🔒 = open elsewhere) |
| `!teleport <id> [brain] [force]` | Pull any session into this thread. `force` takes over one open in another process |
| `!recall <text>` | Search past sessions in memory |
| `!help` / `!agents` / `!models` | Reference |

---

## Cline

Install the Cline CLI, then set it as default or pick it per session.

```bash
npm i -g cline
cli-controller doctor
```

```env
CLI_CONTROLLER_DEFAULT_BRAIN=cline
CLINE_BIN=cline
```

Per session from Slack:

```text
!new brain=cline dir=~/projects/myrepo provider=anthropic model=claude-sonnet-4 fix the failing tests
```

Inside a thread, `!provider <name>` and `!model <name>` apply to the next turn.

---

## How it runs the agent

The bridge drives Kiro **headlessly** by default: `kiro-cli chat --no-interactive --resume-id <id>`, with the prompt fed on stdin. The process runs one turn and exits. Session continuity comes from `--resume-id` replaying the on-disk transcript, not a live process, so idle threads hold no processes.

An optional **interactive PTY** path (`node-pty`, enabled with `KIRO_PTY_RESUME=1`) exists to rehydrate resumed TUI or subagent sessions that headless resume cannot reconstruct (Kiro#9066). It stays off by default. Full breakdown with a decision diagram: [`plans/rupeshkashyap/cli-controller-npm-publish/pty-headless-modes.md`](plans/rupeshkashyap/cli-controller-npm-publish/pty-headless-modes.md).

---

## Security

This is remote code execution on your own machine, by design. The safe defaults matter:

- The wizard sets `SLACK_ALLOWED_USER_IDS` to just you. Never use `*` on a shared workspace.
- Tool trust is opt-in. `KIRO_TRUST_TOOLS=fs_read` (read-only) is the default. `ALL` grants full autonomy including shell commands, so keep it off a work box.
- The web cockpit binds to `127.0.0.1`.
- Your prompts and the agent's output pass through Slack's servers. For work code, confirm this fits your data policy first.

`cli-controller doctor` warns on risky combinations. More in [`SECURITY.md`](SECURITY.md).

---

## Lifecycle

```bash
cli-controller start | stop | restart | status | doctor
cli-controller bridge <cmd>    # Slack bridge only
cli-controller panel  <cmd>    # web cockpit only (http://localhost:1234)
```

## Architecture

Layered: **Interfaces** (Slack, web) → **Manager / Orchestrator** → **core** (runner, brain registry, memory) → **Brains** (Kiro, Cline). Details in [`plans/architecture/architecture.md`](plans/architecture/architecture.md) and [`plans/architecture/arch_2_sequence.md`](plans/architecture/arch_2_sequence.md).

## Development

```bash
npm test         # node:test — core, libs, parsing
```

Adding a brain or an interface: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
