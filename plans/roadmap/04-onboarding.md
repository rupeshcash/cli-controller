# 04 — Natural-language onboarding (`cli-controller` setup)

> Read [`README.md`](README.md) §2 (doctrine).
> Outcome: a first-time user runs **`cli-controller`**, and in plain language picks a **Brain**, then a **bridge (Slack)** with guided token steps, then **finishes onboarding either by chatting with their bot or in the CLI** — on Windows or macOS, in about a minute.

---

## 1. The `cli-controller` entrypoint

Today the entrypoints are `bridge` and `panel` (bash). Introduce one primary binary — **`cli-controller`** — that is the front door for everything. `bridge`/`panel` become subcommands (kept working for muscle memory).

```
cli-controller                 # no config → runs the setup wizard; configured → status + interactive menu
cli-controller setup           # (re)run the wizard, idempotent
cli-controller doctor          # diagnostics (§6)
cli-controller bridge start|stop|restart|status
cli-controller panel open|start|stop
cli-controller <free text>     # NL: routed by the Brain to a config action or a session (§5)
```

Cross-platform from day one: a Node-based CLI (works identically on Windows/macOS), not bash. Config lives at **`~/.cli-controller/config.json`**; secrets go to the **OS keychain** (`keytar`) with a `.env` fallback for headless boxes. This replaces the macOS-only bash lifecycle for the user-facing path (the `run.sh` CA trick is folded into the Node launcher — §7).

## 2. Design principle: the Brain powers the onboarding

The reason we ask for a Brain **first** is that the Brain then **drives the rest of onboarding in natural language** — the same trick as the message broker (`01` §2). Once a Brain is connected, the user can type intent ("I mostly work in ~/work/api and ~/side/blog, default to opus") and the Brain returns structured config the wizard applies. So onboarding is conversational, not a flag interrogation. Menu-driven fallback always exists for those who prefer it.

## 3. Step 1 — Choose a Brain

Reference points (how mature CLIs onboard a model/provider), adopted deliberately:
- **`gh auth login`** — detect + interactive, validates immediately.
- **`aider`** — "which provider? paste API key," supports many providers.
- **Claude Code / Kiro** — subscription/device login, no key.
- **`ollama`** — local runtime detection.

The wizard:
1. **Auto-detects** installed AI CLIs on `PATH` (`kiro-cli`, `cline`, later `claude`, `codex`) and their auth status via each brain's `doctor()` (`01` §3).
2. Presents, conversationally:
   ```
   Which AI brain should power your sessions?
     1) Kiro       ✓ detected, signed in
     2) Cline      ✓ detected            (needs a provider/key — I'll help)
     3) API key    (Anthropic / OpenAI / Gemini / OpenRouter — for a direct-API brain)
     4) Something else on my PATH
   ```
3. For a **CLI brain** (Kiro/Cline): if `doctor()` says not authed, show the exact tool-specific login command/steps; re-check.
4. For an **API-key brain**: ask provider → paste key → validate with a cheap call → store in keychain. (Direct-API brains are a later brain type; the onboarding path is reserved now so the wizard is future-proof without building them.)
5. Set this as the **default brain**; per-session override always available later.

**Wide support, honest scope:** the *menu* lists many providers, but only implemented brains actually run. Unimplemented picks say "coming soon — Kiro/Cline are available today" rather than dead-ending.

## 4. Step 2 — Choose a bridge (Slack today)

```
How do you want to reach it from your phone?
  1) Slack   (recommended — official, no account-ban risk, works behind firewalls)
     [ more bridges coming later ]
```
Only Slack is shown (be honest — don't list unbuilt bridges). Then, guided token capture:

1. **Two tokens needed:** Bot token (`xoxb-`) + App-level token (`xapp-`, Socket Mode).
2. The wizard prints **copy-paste-ready steps** and offers to **open the Slack app-creation page** in the browser:
   - Create app (from-manifest option: ship a ready manifest with the exact scopes — `chat:write`, `reactions:write`, `files:write`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history` — and Socket Mode enabled). A manifest makes this near one-click.
   - Enable Socket Mode → generate `xapp-` token.
   - Install to workspace → copy `xoxb-` token.
3. Paste both → wizard **validates** (`auth.test`) and stores them in the keychain.
4. Set the **allow-list**: default to *just you* (your own Slack user id, auto-detected from `auth.test`) — **never** default to `*` (safety; `02` §4). Explain the channel-vs-DM behavior in one line.

## 5. Step 3 — Continue onboarding by chatting (or in the CLI)

Once Slack is validated, the wizard says:

```
✓ You're connected. Two ways to finish setup — pick either:
  • Open Slack, DM your bot, and just tell it what you want
    (e.g. "register my repos in ~/work and default to Kiro with opus").
  • Or keep going here in the terminal.
```

From here the user is **self-onboarding via natural language**, on either surface, because both the CLI free-text path (§1) and the Slack DM go through the **same core + Brain broker**:
- "register my repos in ~/work" → Brain returns workspace-registry entries → wizard/core writes them.
- "default to Cline in the blog repo" → sets a per-workspace `defaultBrain`.
- "start a Kiro session in api and add rate limiting" → this is no longer setup — it's their first real session. Onboarding dissolves seamlessly into use.

The **workspace registry** (`~/.cli-controller/config.json`) captured here powers safer routing, the web composer's workspace picker (`03`), and NL routing accuracy:
```jsonc
{ "version": 1,
  "defaultBrain": "kiro",
  "workspaces": {
    "api":  { "path": "~/work/api",       "defaultBrain": "kiro",  "defaultModel": "opus", "tags": ["work"] },
    "blog": { "path": "~/side/blog",       "defaultBrain": "cline", "tags": ["personal"] }
  } }
```

## 6. `cli-controller doctor`

One command, cross-platform, that the wizard also runs at the end:
```
✓ Node 20+                         ✓ Slack bot token valid (workspace: my-space)
✓ Kiro brain: found, signed in     ✓ Socket Mode reachable
✗ Cline brain: not found           ⚠ allow-list is '*'  — recommend restricting to you
✓ workspace 'api' path exists       ✗ workspace 'blog' path missing
✓ panel port 1234 free             ✓ session store readable
```
Checks: brain install/auth (via each `brain.doctor()`), Slack token + Socket Mode, workspace paths, port availability, bridge/panel process status (cross-platform), keychain access, and the safety warnings (allow-all, trust-all). `doctor --reindex` rebuilds the search index (`03`).

## 7. Cross-platform specifics (constraint #6)
- **Node CLI**, no bash dependency in the user path. Process control (start/stop/status/kill-tree) uses cross-platform Node (`03` §5).
- **TLS/corporate CA:** the launcher sets `NODE_EXTRA_CA_CERTS` from an exported system bundle *before* the app boots (folds `run.sh`'s job into Node), and `doctor`/setup can offer to export the system CA on a corporate box. No-op on machines without a proxy.
- **Autostart (optional, offered — not forced):** launchd plist (macOS) / Scheduled Task or `nssm`-style service (Windows). The wizard asks "start on login?" and only sets it up on yes.
- **Paths:** accept `~` and native separators; store normalized; validate existence at setup and in `doctor`.

## 8. Phasing (P5; needs P1 core + P3 Slack controller)
1. `cli-controller` Node entrypoint + `config.json`/keychain + subcommand wrappers for `bridge`/`panel`.
2. Wizard **Step 1 (Brain)**: detection, `doctor()` per brain, default-brain selection, API-key path (storage + validation; brains themselves later).
3. Wizard **Step 2 (Slack)**: app-manifest + guided token steps + `auth.test` validation + self-only allow-list default.
4. Wizard **Step 3**: hand-off message + NL free-text path (CLI and Slack) → workspace registry + defaults via the Brain broker.
5. `cli-controller doctor` (+ `--reindex`); autostart opt-in; CA export helper.
6. Gate: on a clean Windows box **and** a clean macOS box, a new user goes from `npm i -g` (`05`) → `cli-controller` → chatting with their bot in **≤ 1 minute**, with self-only allow-list and a validated brain.
