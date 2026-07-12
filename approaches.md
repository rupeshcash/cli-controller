# CLI Controller — Top 3 Approaches (Fast + Ban-Safe)

> **Your ask**: fast to set up, and bottom-line safe — must **not** get your WhatsApp number blocked.
> **Author**: Kiro · **Date**: 2026-07-06

## The one rule that decides everything

There are two families of WhatsApp integration:

| Family | How it connects | Ban risk to your number |
|---|---|---|
| **Unofficial** (whatsapp-web.js, Baileys) | Links *your* WhatsApp as a "linked device" and automates it | ⚠️ **Real, non-deterministic ban risk.** Meta's ML flags automated linked sessions. This is what gets numbers blocked. |
| **Official** (Meta Cloud API / Twilio) | You message a **separate business/sandbox number**; your personal account is never linked or automated | ✅ **Zero ban risk to your number.** Nothing about your real WhatsApp is touched. |

**Bottom line:** the only way to be truly safe is to go through the **official WhatsApp Business API**. You don't chat "as yourself being automated" — you chat *with a bot number*. All 3 options below do this. That's why they're safe.

---

## ✅ Option 1 — Twilio WhatsApp Sandbox → coding agent (RECOMMENDED)

**What it is:** Twilio gives you a shared, pre-approved WhatsApp number instantly. You send `join <keyword>` to their sandbox number (`+1-415-523-8886`) from your phone, and you're connected. A small bridge relays your messages to a coding agent (Claude Code / Codex) on your machine and streams replies back.

**Why it's safe:** Official WhatsApp Business Platform. Your personal number is never linked or automated — you're just texting a bot. Zero ban risk.

**Speed:** ⚡ Live in ~5–10 minutes (sandbox needs no number approval). $15 free Twilio credit to start.

**The bridge:** [`steipete/warelay` (clawdis)](https://github.com/steipete/warelay) — purpose-built for exactly this (Twilio + Tailscale → Claude Code). Or a ~40-line webhook if you want to own it.

**Caveats:**
- Sandbox number shows a Twilio logo and rate-limits to 1 msg / 3s — fine for personal use; graduate to a dedicated approved sender later if you want your own number/branding.
- Business-initiated messages need pre-approved templates, but *your* messages → agent → reply works freely within the 24h session window.

**Best for:** both personal **and** work (work allows WhatsApp; this is the compliant way to do it).

---

## ✅ Option 2 — Meta WhatsApp Cloud API (direct, free)

**What it is:** Same official platform, straight from Meta — no Twilio middleman. Meta gives you a free **test number** in the developer dashboard; you point a webhook at your machine's bridge.

**Why it's safe:** Fully official Meta API. Again, you text a business number, not your linked personal account. Zero ban risk.

**Speed:** 🔸 ~30–60 minutes (create a Meta developer app, add WhatsApp product, grab the test number + token, set webhook). More clicks than Twilio, but **$0** and no third party.

**The bridge:** A small webhook server (receives Meta's POST, calls `claude -p` / `codex exec`, replies via the Cloud API send endpoint). Slightly more DIY than Option 1.

**Caveats:**
- More initial dashboard setup than Twilio.
- Free test number is capped to a few verified recipient numbers — perfect for a single-user personal/work bridge, not for scale.

**Best for:** you want zero ongoing cost and no dependency on Twilio, and don't mind 30 extra minutes of setup.

---

## ✅ Option 3 — Telegram bot for personal + Twilio WhatsApp for work

**What it is:** Use the **Telegram Bot API** for your *personal* agent (it's the single safest, fastest messaging bridge that exists — there's literally no "ban your number" concept for bots), and keep **Twilio WhatsApp** (Option 1) only for *work*, where WhatsApp is mandated.

**Why it's safe:** Telegram bots are first-class and official — @BotFather issues a token, done. No account linking, no ban risk, ever. Work stays on the compliant Twilio path.

**Speed:** ⚡ Telegram side is the fastest of all — ~3 minutes (talk to @BotFather, get token, run a bridge). Work side = Option 1's 5–10 min.

**The bridge:** Any of the many Telegram↔Claude Code bridges, or a tiny `grammy`/`telegraf` script that shells out to your agent in headless mode.

**Caveats:**
- Two transports to run (but the core logic is identical — matches your "transport-agnostic" principle).
- Only viable if "personal on Telegram" is acceptable to you (you mentioned it earlier as an option).

**Best for:** you want the *absolute* fastest + safest personal setup and are fine splitting personal (Telegram) from work (WhatsApp).

---

## Quick comparison

| | Setup speed | Ban risk | Cost | Work-eligible | Best when |
|---|---|---|---|---|---|
| **1. Twilio WhatsApp** | ~5–10 min | ✅ None | $15 free credit, then usage | ✅ Yes | Default — one channel for both |
| **2. Meta Cloud API** | ~30–60 min | ✅ None | Free (test number) | ✅ Yes | Want $0 + no Twilio |
| **3. Telegram + Twilio** | ~3 min (TG) | ✅ None | Free (TG) | ✅ (work via Twilio) | Fastest personal, split channels |

---

## ⚠️ What I deliberately left OUT of the top 3

**Unofficial-library tools** like `whatsapp-claude-agent` / `whatsapp-agent-cli` (QR-scan your own WhatsApp). They're the *fastest to a working coding agent* (10 min) and very polished — **but they link and automate your real account, which is exactly what gets numbers banned.** They fail your "must not block my number" bar.

If you ever want that speed anyway, the only responsible way is a **dedicated throwaway number** (spare SIM) — so a ban never touches your real number. That quarantines the risk; it doesn't remove it. Not recommended given your stated priority, but noted for honesty.

---

## My recommendation

**Go with Option 1 (Twilio WhatsApp Sandbox).** It's safe by construction (your number is never linked), live in minutes, works for both personal and work, and has a ready-made bridge (`warelay`). Start there; if you later want $0 cost, migrate the same bridge to Option 2 (Meta direct).

**Next step:** say the word and I'll scaffold Option 1 in `cli-controller/` — a `SETUP.md` (Twilio sandbox steps) + a minimal, safe webhook bridge that relays WhatsApp ⇄ your coding agent in ask-permission mode.
