# cli-controller

Drive [Kiro CLI](https://kiro.dev) coding agents from **Slack** — from your phone, without SSH — plus a local **web dashboard** to see and resume every session (terminal *or* Slack) in one place.

Built for a real need: control AI coding sessions on your dev machine while away from it, safely, with sessions you can hand off between terminal and chat.

## What's inside

| Component | What it does |
|---|---|
| **`slack-bridge/`** | Slack ⇄ Kiro CLI bridge (Socket Mode). Each Slack thread = one Kiro session. |
| **`web-ui/`** | Local dashboard (`localhost:1234`) — unified session history, bridge control, live logs. |
| Decision docs | `evaluation.md`, `approaches.md`, `free-safe-recommendation.md`, `work-laptop-options.md` — why Slack + Socket Mode over WhatsApp/Telegram/Signal. |

## Why Slack (short version)

Slack's official **Socket Mode** (outbound WebSocket) needs no public URL, no port-forwarding, and — unlike unofficial WhatsApp libraries — carries **no account-ban risk**. It's free, and it's usually already sanctioned at work. See [`evaluation.md`](evaluation.md) for the full analysis.

## Highlights

- **Thread = session.** Send a message → a Kiro session opens in a thread; reply in the thread to continue; each new message is an independent, parallel session.
- **Natural-language routing.** Just type *"in the 2025 java-utils repo, use opus to fix the failing SLA test"* — a fast router picks the directory, agent, and model for you (great on a phone). Explicit `!new`/quick-aliases bypass it.
- **Quick starts.** `!25-opus`, `!26-sonnet`, … — one-shot presets (dir + model + agent) from config.
- **Find & resume anything.** `!recent` lists all sessions (terminal + Slack, 🔒 = open elsewhere); `!teleport <id>` pulls any session into a thread and continues it with the right dir/agent.
- **In-thread controls.** `!model`, `!agent`, `!verbose`, `!peek`, `!abort`, `!clear`, `!end`.
- **Clean output.** Markdown → Slack via `slackify-markdown`; long output → uploaded file snippet; ⏳→✅/❌ status reactions.
- **Web dashboard.** Sortable/filterable session list, per-session copy-to-resume command, bridge start/stop/restart, live log filter.

## Quickstart

```bash
# 1. Slack bridge
cd slack-bridge
cp .env.example .env      # fill SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ALLOWED_USER_IDS, etc.
npm install
./bridge start            # or: npm start

# 2. Web dashboard (optional)
cd ../web-ui
npm install
./panel open              # starts on :1234 and opens the browser
```

Full Slack-app setup (scopes, Socket Mode, Messages tab) → [`slack-bridge/SETUP.md`](slack-bridge/SETUP.md).
Usage guide → [`slack-bridge/TUTORIAL.md`](slack-bridge/TUTORIAL.md) · Session model & internals → [`slack-bridge/LIFECYCLE.md`](slack-bridge/LIFECYCLE.md).

## Configuration (`slack-bridge/.env`)

| Var | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Bot (`xoxb-`) + Socket Mode (`xapp-`) tokens |
| `SLACK_ALLOWED_USER_IDS` | `*` for all, or comma-separated Slack user IDs |
| `KIRO_AGENT` / `KIRO_DEFAULT_CWD` / `KIRO_MODEL` | Defaults |
| `KIRO_TRUST_TOOLS` | `ALL` (full autonomy) / `fs_read` / empty |
| `KIRO_DIR_ALIASES` | `name:path,…` workspace shortcuts |
| `KIRO_QUICK_ALIASES` | `name:dir\|model\|agent,…` one-shot presets (`!<name>`) |
| `KIRO_BROKER` / `KIRO_BROKER_MODEL` | NL router on/off + model |
| `KIRO_TIMEOUT_MS` | `0` = no timeout (default) |
| `KIRO_SNIPPET_THRESHOLD` | Chars before output is uploaded as a file (default 3800) |

## Security

This is remote control of your machine over chat. Keep the Slack workspace private to you, keep `SLACK_ALLOWED_USER_IDS` tight (or `*` only in a solo workspace), and choose `KIRO_TRUST_TOOLS` deliberately (`ALL` = the agent runs commands without asking). Secrets (`.env`), local state, and logs are gitignored and never committed.

## License

MIT — see [LICENSE](LICENSE).
