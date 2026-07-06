# cli-controller

Control AI coding CLIs (Kiro, and easily others) from your phone via chat — safely.

This repo contains:
- **`slack-bridge/`** — the working product: a **Slack ⇄ Kiro CLI** bridge with a chat-first UX.
- **Decision docs** at the root that explain *why* Slack + Socket Mode was chosen over WhatsApp/Telegram/Signal:
  `evaluation.md`, `approaches.md`, `free-safe-recommendation.md`, `work-laptop-options.md`.

## Why Slack (short version)

- **Safe:** the bridge uses Slack's official **Socket Mode** (outbound WebSocket) — no account-linking, no ban risk, no public URL/port-forwarding. WhatsApp via unofficial libraries risks a number ban; via the official API it's now cost- and ToS-hostile to AI agents.
- **Work-friendly:** Slack is usually already sanctioned at work; a personal Slack workspace sidesteps app-install approval.
- **Free:** Slack Bot/App API is free.

See [`slack-bridge/`](slack-bridge/) for the implementation and [`evaluation.md`](evaluation.md) for the full analysis.

## Quickstart

```bash
cd slack-bridge
cp .env.example .env      # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ALLOWED_USER_IDS
npm install
bash run.sh               # or: npm start
```
Full setup (Slack app creation, scopes, Socket Mode) → [`slack-bridge/SETUP.md`](slack-bridge/SETUP.md).

## The UX (thread = session)

- **Send any message** to the bot → new Kiro session; it replies **in a thread**.
- **Reply in that thread** → same session continues (no command).
- **Each top-level message** → an independent, parallel session.
- Default agent is **`main`**; status shows as reactions (⏳ → ✅ / ❌).

Full guide → [`slack-bridge/TUTORIAL.md`](slack-bridge/TUTORIAL.md).
How sessions/memory work → [`slack-bridge/LIFECYCLE.md`](slack-bridge/LIFECYCLE.md).

## Security

The bridge is remote control of your machine over chat. Keep the Slack workspace private to you, keep `SLACK_ALLOWED_USER_IDS` tight (or `*` only in a solo workspace), and be deliberate with `KIRO_TRUST_TOOLS` (`ALL` = full autonomy). Secrets (`.env`) are gitignored and never committed.

## Status

Working MVP. Not yet pushed to a remote — intended for a private GitHub repo.
