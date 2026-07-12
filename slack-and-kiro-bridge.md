# Slack + Kiro CLI Bridge (work laptop)

> **Your setup**: you use **kiro-cli**, so vendor phone-remotes (Claude Code Remote Control, Codex-in-ChatGPT) don't apply — they only drive their own tool. You need a **channel-agnostic** bridge. You asked about **Slack**.
> **Author**: Kiro · **Date**: 2026-07-06

## Key finding: Kiro CLI is bridge-friendly (headless mode exists)

Verified from `kiro-cli chat --help` on this machine:

| Flag | Use |
|---|---|
| `kiro-cli chat --no-interactive "<prompt>"` | **Headless** — runs one turn, prints answer, exits. This is what makes a clean bridge possible. |
| `--resume-id <SESSION_ID>` / `--resume` | Multi-turn session persistence (your FR3) |
| `--trust-tools=fs_read,fs_write` / `--trust-all-tools` | Permission control (keep it tight on a work box) |
| `--agent <AGENT>`, `--model <MODEL>`, `--effort <level>` | Per-session config |
| `--list-sessions`, `-f json` | Structured output for `/sessions` |

**So the bridge is small:** on each incoming message → `kiro-cli chat --no-interactive --resume-id <session> "<prompt>"` → capture stdout → send back. No PTY/ANSI wrangling. This is the "easy" path your original spec worried about (FR5/FR9) — Kiro's headless mode removes the hard part.

---

## Is Slack a good idea for work? Mostly yes — with one real caveat

**Why Slack beats Telegram/Signal/WhatsApp for a *work* laptop:**
- ✅ **It's probably already sanctioned.** Slack is very often *the* corporate chat tool — already installed and IT-approved on your work laptop. That's the whole problem with Telegram/Signal/WhatsApp (not allowed); Slack usually is.
- ✅ **Official + safe.** Slack has a first-class **Bot/App API**. No "get your account banned" mechanism like WhatsApp. Legitimate.
- ✅ **Free.** Building/running a Slack app is free; even a free Slack workspace works.
- ✅ **Firewall-friendly via Socket Mode.** A Slack app in **Socket Mode** connects with an *outbound* WebSocket — **no public URL, no port-forwarding, no inbound firewall hole**. Perfect for a laptop behind corporate NAT. (This is a big advantage over a webhook approach.)
- ✅ **Rich UX.** Threads, code blocks, `/slash` commands, message chunking — maps cleanly onto your FR6/FR7/FR8/FR10.

**The one real caveat:**
- ⚠️ **Installing a custom app into your *company's* Slack workspace usually needs admin/IT approval.** Corporate workspaces restrict app installs.
  - **Workaround:** create your **own free personal Slack workspace**, install your bot there, and add that workspace to the Slack client that's already on your work laptop (Slack supports multiple workspaces in one app). You DM your bot in your personal workspace — no corporate admin needed.

---

## Recommended architecture (Slack ⇄ Kiro)

```
Slack (your DM / personal workspace)
   │  Socket Mode (outbound WebSocket — no public URL)
   ▼
Bridge (small Node/Python process on the work laptop)
   • whitelist: only your Slack user ID
   • /new /use /sessions /status /abort /help  → commands
   • anything else → prompt
   ▼
kiro-cli chat --no-interactive --resume-id <session> "<prompt>"
   • per-Slack-thread ↔ Kiro session mapping (FR3)
   • --trust-tools kept minimal (safety)
   ▼
stdout → buffer → post back to Slack (split long messages)
```

- **Sessions:** map one Slack thread → one `--resume-id`. New thread or `/new` → fresh session.
- **Safety:** run Kiro with a minimal `--trust-tools` set (or none) so it asks before writing/executing on the work machine. Never `--trust-all-tools` on a work box.

---

## Work-laptop options for Kiro, ranked

| Option | Works w/ Kiro | Safe | Free | Likely work-allowed | Effort |
|---|---|---|---|---|---|
| **Tailscale + SSH + tmux** | ✅ (TUI runs natively, zero bridge code) | ✅ | ✅ | ⚠️ needs IT OK for Tailscale/SSH | ~15 min |
| **Slack bot (Socket Mode) → `kiro-cli --no-interactive`** | ✅ | ✅ | ✅ | ✅ Slack usually sanctioned (app-install via personal workspace) | small bridge |
| Telegram bridge | ✅ | ✅ | ✅ | ❌ not allowed at work | small bridge |
| Signal / WhatsApp | ✅ if bridged | ❌/⚠️ | ~ | ❌ | high |

**My take:**
1. **If IT allows Tailscale + SSH** → do that. It's the cleanest for Kiro because its interactive TUI just runs over SSH — no bridge, no headless mode, full features. Simplest and most powerful.
2. **If SSH/Tailscale is blocked but Slack is your work tool** → **Slack bot in Socket Mode → headless Kiro**, using a personal Slack workspace to sidestep app-install approval. This is the best *chat-based* work option, and now easy thanks to `--no-interactive`.

---

## The non-negotiable caveat (work machine)

Whatever the channel, this is **remote control of a work dev machine**. Slack being allowed as a *chat app* is not the same as your org allowing an *AI agent driven remotely to run commands on the work laptop*, and work code/output would transit Slack's servers. Get an explicit OK from IT/security, keep Kiro in ask-permission mode (minimal `--trust-tools`), and prefer a sanctioned Tailscale+SSH or Slack-app setup over anything unofficial. A sanctioned setup is both safer and far easier to defend.

---

## Next step
Say the word and I'll scaffold into `cli-controller/`:
- **`scaffold slack`** → a Socket-Mode Slack bridge (`@slack/bolt`) → `kiro-cli --no-interactive`, single-user whitelist, thread↔session mapping, safe `--trust-tools`, long-message splitting + a `SETUP.md` (personal-workspace + bot-token steps).
- **`scaffold ssh`** → a short IT-approval-ready note + Tailscale/SSH/tmux setup for driving `kiro-cli chat` natively from your phone.

## References
- Kiro CLI flags — verified locally via `kiro-cli chat --help` (`--no-interactive`, `--resume-id`, `--trust-tools`, `--list-sessions -f json`).
- Slack Socket Mode (outbound WebSocket, no public URL) and Bolt SDK — Slack API docs (`api.slack.com`).
