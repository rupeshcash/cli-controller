# Kiro Slack Bridge — Setup

Control `kiro-cli` from Slack. The bot runs on your machine, connects to Slack over **Socket Mode** (outbound WebSocket — no public URL, no port-forwarding, firewall-friendly), and drives Kiro in headless mode (`kiro-cli chat --no-interactive`).

## 0. Prereqch
- Node.js 18+ (`node -v`)
- `kiro-cli` installed and authenticated (`kiro-cli chat --list-models` should work)

## 1. Create the Slack app (~5 min)

> Tip for work: if you can't install apps into your **company** Slack workspace (needs admin), create a **free personal Slack workspace**, build the app there, and add that workspace to the Slack client already on your laptop. You'll DM the bot in your personal workspace — no corporate admin needed.

1. Go to **https://api.slack.com/apps → Create New App → From scratch**. Name it (e.g. `Kiro Bridge`), pick your workspace.
2. **Socket Mode** (left sidebar) → toggle **Enable Socket Mode** ON.
   - When prompted, create an **App-Level Token** with scope `connections:write`. Copy it — this is your **`SLACK_APP_TOKEN`** (starts with `xapp-`).
3. **OAuth & Permissions** → **Bot Token Scopes** → add:
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `reactions:write` *(optional but recommended — enables ⏳/✅/❌ status reactions; without it the bot falls back to a "working…" text message)*
4. **Event Subscriptions** → toggle **Enable Events** ON → under **Subscribe to bot events** add:
   - `message.im`
   (Socket Mode delivers these over the WebSocket; no Request URL needed.)
5. **App Home** → **Show Tabs** → enable the **Messages Tab**, and check **"Allow users to send Slash commands and messages from the messages tab."** (so you can DM the bot).
6. **Install App** (OAuth & Permissions → Install to Workspace). Approve. Copy the **Bot User OAuth Token** — this is your **`SLACK_BOT_TOKEN`** (starts with `xoxb-`).
7. Get **your** Slack user ID: your profile → **⋮ (More)** → **Copy member ID** (starts with `U`).

## 2. 👉 Where to put your tokens

In this folder (`cli-controller/slack-bridge/`):

```bash
cp .env.example .env
```

Then open **`.env`** and fill in:

```
SLACK_BOT_TOKEN=xoxb-...        # from step 6  (Bot User OAuth Token)
SLACK_APP_TOKEN=xapp-...        # from step 2  (App-Level Token, Socket Mode)
SLACK_ALLOWED_USER_IDS=U0XXXX   # from step 7  (your member ID; comma-separate for more)
KIRO_DEFAULT_CWD=/path/to/repo  # the directory you want Kiro to work in
KIRO_TRUST_TOOLS=fs_read        # safe default (read-only). See notes below.
```

**That's it — the bot token goes in `.env` as `SLACK_BOT_TOKEN`.** `.env` is gitignored, so it won't be committed.

## 3. Install & run

```bash
npm install
npm start
```

You should see `⚡ Kiro Slack bridge running (Socket Mode).` Now open Slack, DM your app, and try:

```
!help
!status
!new
Summarize the README in this repo.
!sessions
```

## 4. Commands

| Command | Action |
|---|---|
| `!new` | Start a fresh Kiro session |
| `!sessions` | List recent sessions in the current directory |
| `!use <sessionId>` | Resume a specific session |
| `!cd <path>` | Change working directory (resets session) |
| `!model <name>` | Set model (e.g. `claude-sonnet-4.6`); `!model clear` for default |
| `!status` | Show current dir / session / model |
| `!abort` | Stop the current run |
| `!help` | Show commands |

Anything **not** starting with `!` is sent to Kiro as a prompt. Multi-turn context is kept per DM via Kiro's `--resume-id`.

## 5. Safety notes (read if this touches a work machine)

- This is **remote control of your machine**. Keep `SLACK_ALLOWED_USER_IDS` to just you.
- `KIRO_TRUST_TOOLS` controls what Kiro may do **without asking** (headless mode can't show permission prompts):
  - `fs_read` (default) — read-only. Safe.
  - `fs_read,fs_write` — allow file edits.
  - `ALL` — full autonomy incl. running shell commands. **Do NOT use on a work laptop.**
- Your prompts and Kiro's output flow through **Slack's servers**. If this is for work, confirm that's acceptable under your data policy, and get IT/security sign-off before running against work code.
- Run it as your own user (not root). Consider a dedicated repo directory rather than your home folder.

## 6. Keep it running (optional)
- macOS/Linux quick option: `nohup npm start > bridge.log 2>&1 &`
- Or use `pm2`, a `launchd` plist (macOS), or a `systemd` user service (Linux) for auto-restart.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Bot ignores you | Your user ID isn't in `SLACK_ALLOWED_USER_IDS`, or you're messaging in a channel (must be a **DM**). |
| `Missing SLACK_..._TOKEN` on start | `.env` not filled in / not in this folder. |
| `not_allowed_token_type` | You swapped the tokens — `xoxb-` is `SLACK_BOT_TOKEN`, `xapp-` is `SLACK_APP_TOKEN`. |
| Can't DM the bot | Enable **Messages Tab** (step 5) and reinstall the app. |
| Kiro seems to do nothing but reply | `KIRO_TRUST_TOOLS` too restrictive — allow more tools if you want it to act. |
| Bot connects but never replies to DMs | Slack **Event Subscriptions** must include `message.im` **and** the **Messages Tab** must be enabled (step 4–5). Reinstall the app after changing. |
| `unable to get local issuer certificate` (behind corp proxy) | A TLS-inspecting proxy/security agent injects a root CA Node doesn't trust. Export the macOS-trusted roots and launch via `run.sh` (which sets `NODE_EXTRA_CA_CERTS`):<br>`security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > macos-ca.pem`<br>`security find-certificate -a -p /Library/Keychains/System.keychain >> macos-ca.pem` |
| `[WARN] Socket Mode is not turned on` | Benign if `apps.connections.open` returns `ok:true`. It does not stop delivery. |

---

## Using the bot in channels (not just DMs)

By default the bridge works in the bot's DM tab. To also drive it from a channel:

**1. Bot Token Scopes** (OAuth & Permissions) — add alongside the existing ones:
- `app_mentions:read`
- `channels:history` (public channels)
- `groups:history` (private channels)
- `mpim:history` (group DMs) — optional

**2. Event Subscriptions** → *Subscribe to bot events* — add:
- `app_mention`
- `message.channels`
- `message.groups`
- `message.mpim` (optional)

Reinstall the app after changing scopes.

**3. Invite the bot to the channel:** `/invite @your-bot`.

**How it behaves in a channel (by design):**
- **Start a session:** `@your-bot fix the flaky test in api` — an @mention is required to start, so the bot never treats ordinary channel chatter as a task.
- **Continue:** just reply in that thread — no mention needed.
- **Access control still applies:** `SLACK_ALLOWED_USER_IDS` gates *who* can trigger a run. A channel may contain people who should not control your machine — only allow-listed users are honored. Keep the allow-list tight for shared channels.

DMs are unchanged (no mention needed).
