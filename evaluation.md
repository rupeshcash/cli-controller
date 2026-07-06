# CLI Controller — Evaluation & Recommendation

> **Context**: You want a phone controller to chat with your work AI and personal AI coding agents over WhatsApp (work) / WhatsApp or Telegram (personal). You wrote a clean product spec (FR1–FR12, NFR1–NFR6). This doc is my honest take on the *fastest and easiest* way to get there.
> **Author**: Kiro (for Rupesh)
> **Created**: 2026-07-06
> **Status**: recommendation — awaiting your pick before scaffolding

---

## TL;DR (my actual opinion)

1. **Don't build this from scratch.** Your spec is essentially a from-scratch build sheet, but the exact product already exists as ≥5 maintained open-source projects (Dec 2025 / 2026). They cover ~90% of FR1–FR12 out of the box. Building it yourself is days of work to re-derive `whatsapp-web.js` + session plumbing others already debugged.
2. **Fastest path for PERSONAL AI: adopt [`dsebastien/whatsapp-claude-agent`](https://github.com/dsebastien/whatsapp-claude-agent)** — single cross-platform binary (native macOS build), one command, whitelist your number, QR scan, done. ~10 minutes to first message.
3. **The WORK side has a real catch that your spec doesn't mention** — see [§4 Compliance & Security](#4-the-work-side-caveat-read-this-before-anything). Unofficial WhatsApp libraries violate WhatsApp ToS and get numbers **banned** by ML heuristics. Linking a work-associated number is doubly risky (ban + corporate policy + exposing a work machine to remote code execution). The zero-ToS-risk work path is the **official WhatsApp Business Cloud API via Twilio**, on a *dedicated* number — not your real one.
4. **The single most important technical decision is not covered in your spec**: drive the coding agent in **headless/non-interactive mode** (`claude -p`, `codex exec`, Agent SDK), *not* by puppeteering its interactive TUI over a pseudo-terminal. Every mature tool does the former. The latter (node-pty + ANSI stripping of `kiro-cli chat`) is the brittle, slow path. This choice drives everything else.
5. **Your Kiro CLI / Cline requirement is the one thing off-the-shelf tools don't do.** They target Claude Code + Codex. If you truly need *Kiro specifically* on the bridge, fork one of these and add one adapter (hours) — still don't build the transport layer yourself.

**My recommendation in one line:** Adopt `whatsapp-claude-agent` for personal today; for work, either (a) use a **dedicated Twilio WhatsApp number** with a compliant bridge, or (b) get explicit security sign-off before linking anything. Only build custom if you specifically need Kiro/Cline — and then fork, don't greenfield.

---

## 1. The landscape — this is a solved problem

| Project | Transport | CLI backend | Auth | Platform | Sessions | Notes |
|---|---|---|---|---|---|---|
| **[dsebastien/whatsapp-claude-agent](https://github.com/dsebastien/whatsapp-claude-agent)** | WhatsApp (whatsapp-web.js) | Claude Code (Agent SDK) | QR, persisted | **Linux/macOS/Windows binary** | resume/fork, per-chat | Whitelist, permission modes, config file, chunking. **Best for macOS, active (1.5.1, Dec 2025).** Claude-only. |
| **[whatsapp-agent-cli](https://pypi.org/project/whatsapp-agent-cli/)** (kalki-kgp) | WhatsApp | **Claude + Codex** | QR, persisted | Linux (systemd) | 30 saved/chat, daily memory rollover | `bootstrap.sh`, Whisper voice→prompt, bot vs self-chat mode. Closest to your full spec. Linux-first. |
| **[crisandrews/claude-whatsapp](https://github.com/crisandrews/claude-whatsapp)** | WhatsApp | Claude Code (plugin) | QR | — | yes | Voice transcription, media, access control. |
| **[OpenClaw / Clawdbot](https://www.datacamp.com/tutorial/moltbot-clawdbot-tutorial)** | **WhatsApp + Telegram + terminal** | Claude coding agent | — | self-hosted gateway | yes | **Multi-transport** — matches your "transport agnostic" principle. Good if you want personal-on-Telegram + work-on-WhatsApp from one core. |
| **[steipete/clawdis (warelay)](https://github.com/steipete/warelay)** | WhatsApp via **Twilio** + Tailscale | Claude Code | **Official API** | — | — | **The compliance-safe path.** Uses Twilio Business API, not an unofficial linked session. Best fit for a *work* number. |
| **[wacli](https://wacli.sh/)** | WhatsApp (linked device, Go) | generic (for scripts/agents) | QR | Go binary | SQLite history | Lower-level building block, not a turnkey agent bridge. |

**Takeaway:** For "chat with a Claude-family coding agent from WhatsApp," you install a binary and scan a QR. The gap between these and your spec is small and specific (Kiro/Cline support, multi-CLI switching UX).

---

## 2. The two independent axes

Your spec correctly separates *transport* from *CLI* (your Guiding Principles are right). Decisions on each:

### Axis A — Transport (WhatsApp)

| Option | ToS/Ban risk | Effort | Resource use | Fit |
|---|---|---|---|---|
| **whatsapp-web.js** (Puppeteer + WhatsApp Web) | ⚠️ Violates ToS, ban risk | Lowest (most examples, most turnkey tools use it) | Heavy (headless Chrome ~300–500MB) | Personal, throwaway/secondary number |
| **Baileys** (`@whiskeysockets/baileys`, WebSocket) | ⚠️ Violates ToS, ban risk | Low | **Light (no browser)** — best for your NFR4 | Personal, if you build custom |
| **WhatsApp Business Cloud API / Twilio** | ✅ **Zero ToS risk** (official) | Medium (Meta/Twilio onboarding, dedicated number) | Light (webhook) | **Work / anything you can't afford to get banned** |

> Verified across multiple 2025/2026 sources: both `whatsapp-web.js` and Baileys run against the consumer app in violation of WhatsApp ToS; bans are ML-driven and non-deterministic (no fixed message cap). The *only* zero-risk route is the official Cloud API via a certified provider (e.g., Twilio).

### Axis B — How you drive the CLI (the decision your spec under-specifies)

| Approach | What it means | Robustness | Speed | When |
|---|---|---|---|---|
| **Headless / print mode** ✅ | `claude -p "<prompt>"`, `codex exec`, or the Claude Agent SDK. One shot in → structured text out. | High | Fast | **Default. What every mature tool does.** |
| **Interactive TUI over PTY** | Spawn `kiro-cli chat` in a `node-pty`, feed keystrokes, strip ANSI escape codes, guess when output "settled." | Low (brittle, ANSI soup, hard to detect "done") | Slow | Only if the CLI has *no* headless mode. |

Your FR5/FR9 ("receive stdout/stderr", "avoid sending individual characters", "buffer chunks") describe the PTY approach. That's the hard 20% that eats 80% of build time. **Recommendation: build/adopt around headless mode.** Claude Code and Codex both have it. Kiro's `kiro-cli chat` is a TUI — confirm whether it exposes a non-interactive/print mode before committing to Kiro-over-bridge; if not, that's the one place PTY pain is unavoidable.

---

## 3. Decision tree

```
Do you need Kiro CLI / Cline SPECIFICALLY on the bridge?
├─ NO (any capable coding agent is fine)
│   └─ Personal → adopt dsebastien/whatsapp-claude-agent (macOS binary) TODAY. 10 min.
│   └─ Work     → §4. Twilio dedicated number + compliant bridge, OR get security sign-off first.
│
└─ YES (must be Kiro/Cline)
    └─ Does that CLI have a headless/print mode?
        ├─ YES → Fork whatsapp-agent-cli (already multi-CLI: Claude+Codex) OR OpenClaw
        │        (multi-transport). Add ONE adapter that shells out to `kiro -p`. Hours, not days.
        └─ NO  → Fork the same, add a node-pty adapter for that one CLI. This is the only
                 scenario where your full FR5/FR9 PTY design is justified — and even then you
                 reuse the transport, sessions, chunking, whitelist from the fork.
```

---

## 4. The WORK side caveat (read this before anything)

Your line "for work only whatsapp is allowed" plus a coding-agent-on-your-work-machine bridge combines three risks your spec's NFR6 doesn't fully capture:

1. **Account ban.** An unofficial linked session on a work-associated WhatsApp number can get that number banned by Meta's heuristics — non-deterministic, no warning. Losing a work number is a bad day.
2. **Corporate policy.** Automating a work comms channel and piping it to a dev box may violate acceptable-use / data-handling policy. "WhatsApp is allowed for messaging" ≠ "linking WhatsApp to a coding agent that can run shell commands is allowed."
3. **Remote code execution surface.** A WhatsApp→coding-agent bridge is, functionally, remote shell access to your work machine gated only by a phone-number whitelist. If your WhatsApp is compromised, so is the machine. **Never run these tools in `bypassPermissions`/`dontAsk` mode against work repos.**

**Compliant work path (my recommendation):**
- Use the **official WhatsApp Business Cloud API via Twilio** on a **dedicated number** (not your personal/work WhatsApp). This is the [clawdis/warelay](https://github.com/steipete/warelay) model. Zero ToS risk, doesn't link your real account.
- Keep the agent in `default`/`plan` (ask-permission) mode for anything touching work code.
- Get an explicit OK from your security team before pointing any bridge at a work machine. This is the one place I'd stop and confirm rather than move fast.

For **personal**, the ban risk is yours to accept — an unofficial-library tool on a spare/secondary number is fine and fast.

---

## 5. My recommended fastest paths

### Path A — "I want it working tonight" (personal, macOS)
```bash
# on your Mac, in a repo directory you want the agent to work in
curl -fsSL https://raw.githubusercontent.com/dsebastien/whatsapp-claude-agent/main/install.sh | bash
whatsapp-claude-agent -w "+<your-number>" -m plan   # start read-only/safe
# scan the QR from WhatsApp → Linked Devices → done
```
- Covers FR1 (QR+persist+reconnect), FR2 (whitelist), FR3 (sessions: `/session`, `/fork`), FR6/FR7 (`/help /status /model /cd` etc.), FR8/FR9 (chunking), FR11 (readable errors). Cross-platform (NFR3), no DB/queue/server (NFR4). Claude-only.
- Start in `-m plan` (read-only), graduate to `acceptEdits` once you trust it. Avoid `bypassPermissions`.

### Path B — "I want Claude *and* Codex + voice notes + rich sessions" (personal, Linux box)
```bash
curl -fsSL https://raw.githubusercontent.com/kalki-kgp/whatsapp-agent-cli/main/scripts/bootstrap.sh | bash
whatsapp-agent install    # pick self-chat or bot mode, enter allowed number
whatsapp-agent pair       # scan QR
```
- Closest single tool to your full spec (multi-CLI, `/new /resume /model /root /status`, 30 saved sessions, Whisper voice→prompt, daily memory). Linux/systemd-first.

### Path C — "I genuinely need Kiro/Cline + the CLI-agnostic adapter architecture from my spec"
- **Fork `whatsapp-agent-cli` (already multi-CLI) or `OpenClaw` (already multi-transport).** Implement your FR5 adapter interface for exactly one new CLI. You inherit transport, auth, sessions, chunking, whitelist, logging for free.
- Only reach for node-pty if that CLI has no headless mode.

### Path D — "compliant work bridge"
- **Twilio WhatsApp Business API + dedicated number**, `warelay`-style, agent in ask-permission mode, behind Tailscale, with security sign-off. Slower to stand up, but the only version I'd point at a work machine.

---

## 6. If you insist on building from scratch (minimal blueprint)

I don't recommend it, but if you want maximum control and to own the code in `cli-controller/`, here's the leanest stack that satisfies your NFRs:

- **Runtime:** Node 20+ (matches the ecosystem; all reference tools are JS/TS).
- **Transport:** **Baileys** (not whatsapp-web.js) — WebSocket, no headless Chrome → satisfies NFR4 (low resource). QR auth + `useMultiFileAuthState` for persistence (FR1). Accept the ToS/ban caveat for personal only.
- **CLI driver:** `child_process.spawn` in **headless mode** (`claude -p`, `codex exec`). Add `node-pty` *only* for a specific TUI-only CLI.
- **Adapter interface (FR5):** `start() / send(input) / onOutput(cb) / onExit(cb) / stop() / kill()`. One file per CLI.
- **Session manager (FR3):** in-memory `Map<sessionId, Session>` + a JSON file for persistence. No DB (NFR4).
- **Router (FR6/FR7):** if message starts with `/` → command, else → active session's `send()`.
- **Output (FR9/FR10):** buffer stdout, flush on idle (~750ms) or on ~3500-char threshold, split long messages with `(1/n)` markers.
- **Effort estimate:** 1–3 focused days to reach your Success Criteria — vs ~10 minutes to adopt Path A. That delta is the whole point of this doc.

Directory sketch if you go this way:
```
cli-controller/
  src/
    transport/whatsapp.baileys.ts     # FR1
    core/router.ts                     # FR6/FR7
    core/sessionManager.ts             # FR3
    core/outputBuffer.ts               # FR9/FR10
    adapters/adapter.ts                # FR5 interface
    adapters/claude.ts                 # headless: claude -p
    adapters/codex.ts                  # headless: codex exec
    adapters/kiro.ts                   # pty fallback if no headless mode
    config.ts                          # FR2 whitelist, NFR6
  package.json
```

---

## 7. Where your spec is strong / where I'd change it

**Strong:** The Guiding Principles (CLI-agnostic, transport-agnostic, persistent conversations) and the FR5 adapter interface are exactly right and match how the mature tools are built. Keep them.

**I'd change / add:**
- **Add a "CLI Interaction Mode" requirement**: prefer headless/print mode; PTY only as fallback. This is the biggest missing decision (see §2B).
- **Strengthen NFR6 (Security)** with the three work-side risks in §4 — especially "never bypass permissions on work repos" and "treat the bridge as remote shell access."
- **Add a ToS/compliance note** distinguishing personal (accept ban risk on a spare number) from work (official API + dedicated number).
- **Reframe "Objective" as "adopt-or-fork first, build last"** given the landscape.

---

## 8. Recommended next step

Tell me which path you want and I'll scaffold it in `cli-controller/`:
- **A** → I'll write a short `SETUP.md` + a safe `run.sh` wrapper (starts in `plan` mode, your number pre-filled).
- **C** → I'll fork-scaffold the adapter interface + a Kiro/Cline adapter stub against `whatsapp-agent-cli`/OpenClaw.
- **D** → I'll write the Twilio + dedicated-number setup checklist and a compliant webhook skeleton.
- **Build-from-scratch** → I'll generate the §6 blueprint as working Baileys + headless-adapter code.

My default suggestion: **Path A for personal now** (prove the workflow in 10 minutes), and **Path D groundwork for work** (dedicated number + security sign-off) before linking anything work-related.

---

## References
- [dsebastien/whatsapp-claude-agent](https://github.com/dsebastien/whatsapp-claude-agent) — cross-platform binary, whatsapp-web.js + Claude Agent SDK, active (1.5.1, Dec 2025)
- [whatsapp-agent-cli (PyPI)](https://pypi.org/project/whatsapp-agent-cli/) · [docs](https://whatsapp-agent-docs.paperknife.app/) — multi-CLI (Claude+Codex), sessions, voice
- [crisandrews/claude-whatsapp](https://github.com/crisandrews/claude-whatsapp) — plugin, voice, media, access control
- [OpenClaw / Clawdbot tutorial](https://www.datacamp.com/tutorial/moltbot-clawdbot-tutorial) — multi-transport (WhatsApp + Telegram + terminal)
- [steipete/clawdis (warelay)](https://github.com/steipete/warelay) — Twilio + Tailscale, compliant path
- [wacli](https://wacli.sh/) — Go, WhatsApp linked-device building block
- [Baileys](https://github.com/whiskeysockets/Baileys) — WebSocket WhatsApp lib (light, no browser)
- ToS/ban risk (multiple, 2025–2026): unofficial libs violate WhatsApp ToS; bans are ML-driven; official Cloud API is the only zero-risk route.
