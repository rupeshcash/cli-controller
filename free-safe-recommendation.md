# Free + Safe Decision (updated for current WhatsApp rules)

> **Your ask**: a solution that is safe (no ban) AND costs nothing. 1 msg / 3s is fine.
> **Author**: Kiro (for Rupesh) · **Date**: 2026-07-06
> **Status**: recommendation — course-correction from `approaches.md`

## TL;DR

- **Twilio WhatsApp is not $0.** Every WhatsApp message carries Twilio's per-message fee (~$0.005 in/out) plus Meta's fees. The trial is *finite credit*, not a free tier.
- **WhatsApp itself now works against this use case.** As of **Oct 2025**, Meta's WhatsApp Business API terms **bar general-purpose AI chatbots** and added **token-based pricing for AI-agent conversations**. An AI coding agent over WhatsApp is exactly what they're restricting + metering. So official WhatsApp is neither free nor ToS-safe for this.
- **The only path that is truly $0 + safe + unrestricted is Telegram.** Official Bot API, no ban concept, no AI-chatbot restriction, ~3-minute setup.

**Recommendation: use Telegram for the AI-agent bridge.** Keep WhatsApp for human messaging only.

---

## Why each WhatsApp option fails your "$0 + safe" bar

| Path | Safe (no ban)? | Truly $0? | Blocker |
|---|---|---|---|
| Unofficial (whatsapp-web.js / Baileys, QR-scan your number) | ❌ ban risk | ✅ free | Fails "safe" — links & automates your real number |
| Twilio WhatsApp (official) | ✅ | ❌ | Per-message fee; trial credit is finite |
| Meta Cloud API direct (official) | ✅ | ❌ (for AI) | **Oct 2025: bars general-purpose AI chatbots + token-based AI-agent charges** |

There is currently **no** WhatsApp path that is simultaneously free, safe, and allowed for an AI agent. That's not a limitation of the tooling — it's Meta's 2025 policy + pricing direction.

---

## The recommendation: Telegram Bot (truly $0 + safe)

**What it is:** Message @BotFather, get a bot token, run a tiny bridge on your machine that relays your Telegram messages to your coding agent (Claude Code / Codex / Kiro in headless mode) and streams replies back.

**Why it wins on your exact criteria:**
- **$0, permanently.** Telegram Bot API is free with no per-message cost.
- **Safe.** Bots are first-class and official — there is no "get your number banned" mechanism. Your account is never automated.
- **No AI-chatbot restriction.** Telegram does not bar AI assistants the way WhatsApp now does.
- **Fast.** ~3 minutes to a working bot; the coding-agent bridge is a small script.
- **1 msg/3s is a non-issue** — Telegram's limits are far higher than that anyway.

**Setup shape (Option 1 to scaffold):**
1. Telegram → @BotFather → `/newbot` → copy the token.
2. Get your own Telegram user ID (whitelist = just you).
3. Run a small bridge: on each message, if it's from your ID, shell out to the agent in headless mode (`claude -p` / `codex exec`), buffer output, reply (split long messages).
4. Start the agent in ask-permission / read-only mode for safety.

---

## What this means for WORK (WhatsApp mandated)

Be aware, plainly: **there is no free + safe + compliant way to run an AI coding agent over WhatsApp right now.**
- Official API → costs money (token-based) **and** may violate the new "no general-purpose chatbot" term.
- Unofficial → ban risk.

Practical options for the work side:
1. **Keep WhatsApp for humans only**; use a different channel (Telegram, or SSH/Tailscale to the machine) for the agent. Cleanest and free.
2. If WhatsApp-to-agent is a hard business requirement, treat it as a **paid, security/legal-approved project** (official API, accept token costs, confirm the AI-chatbot ToS with your org) — not a free weekend setup.

I'd start with #1.

---

## My recommendation in one line

**Build the bridge on Telegram** (free, safe, fast, unrestricted) for both personal and — if policy allows a non-WhatsApp channel — work. Only revisit WhatsApp if the work requirement is immovable, and then only as a paid, approved effort.

**Next step:** say "scaffold Telegram" and I'll drop a `SETUP.md` (BotFather steps) + a minimal, safe bridge into `cli-controller/` — headless agent, single-user whitelist, ask-permission mode, long-message splitting.

---

## References
- Twilio: "All WhatsApp messages incur a per-message fee for use of Twilio's API" ([Twilio WhatsApp FAQ](https://www.twilio.com/docs/sms/whatsapp/best-practices-and-faqs)); per-message ~$0.005 ([pricing](https://jp.twilio.com/whatsapp/pricing)); trial = finite free units ([trials](https://www.twilio.com/docs/usage/trials)).
- Meta bars general-purpose chatbots on WhatsApp Business API, Oct 2025 ([TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/)).
- Meta token-based pricing for WhatsApp Business AI agents, 2025 ([Storyboard18](https://www.storyboard18.com/digital/meta-revamps-whatsapp-business-pricing-with-token-based-ai-model-restores-service-message-charges-102954.htm), [CNBC-TV18](https://www.cnbctv18.com/technology/whatsapp-pricing-overhaul-to-make-openai-anthropic-powered-chatbots-costlier-than-meta-ai-19937997.htm/amp)).
- Telegram Bot API — free ([core.telegram.org/bots/api](https://core.telegram.org/bots/api)).
