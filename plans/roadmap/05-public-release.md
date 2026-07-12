# 05 — Public release & one-minute install

> Read [`README.md`](README.md) §2 (doctrine).
> Outcome: the repo goes **public** and anyone can install and run it in about a minute, with **secure-by-default** settings and a **highly curated README**.

---

## 1. One-minute install (the promise)

The whole install is:

```bash
npm install -g cli-controller     # or: npx cli-controller
cli-controller                    # runs the natural-language setup wizard (04)
```

That's the entire path from nothing to chatting with your bot. Prerequisites are only **Node ≥ 20** and **at least one Brain** — either an AI CLI already on `PATH` (Kiro/Cline) or an API key (the wizard walks you through whichever you pick, `04` §3).

To make this real:
- Publish the package to **npm** with a `bin` entry exposing `cli-controller` (and keep `bridge`/`panel` as subcommands). `engines.node >= 20`.
- **Zero required config to start** — first run detects state and launches the wizard; nothing to hand-edit. `.env` becomes an optional/advanced fallback, not the primary path (`04`).
- Keep runtime deps lean (Bolt, slackify-markdown, keytar, a SQLite driver) so global install is fast.
- `npx cli-controller` must work for try-before-install.

## 2. Naming decision (do before publishing)
`cli-controller` is descriptive but generic and may be taken on npm. **Action:** check npm name availability; pick a distinct product name if needed (the repo can stay `cli-controller` while the npm package/brand differs). Decide before the first publish — renaming after users install is costly. (Non-blocking for the plan; blocking for `npm publish`.)

## 3. Curated README (the front door)

Rewrite the public README to be skimmable and compelling. Target structure:
1. **One-line hook** + a short **animated demo** (GIF/asciinema): make a Slack thread → Kiro edits code → PR. Nothing sells it faster.
2. **60-second quickstart** — the two commands from §1, then "DM your bot."
3. **Why it exists / why Slack** — one paragraph + link to `evaluation.md` (official, no ban risk, works behind firewalls).
4. **What it does** — thread=session, natural-language routing, multi-brain (Kiro + Cline), web cockpit, channel support.
5. **Security** (prominent, not buried) — self-only allow-list default, tool-trust is opt-in, localhost-only web; link `SECURITY.md`.
6. **Supported brains & interfaces** — capability matrix (`01` §7), honest about what's implemented vs planned.
7. **Docs links, contributing, license.**

Keep the decision docs (`evaluation.md`, etc.) but move them under `docs/` so the root stays clean; the current top-level README already reflects most of this and gets upgraded here.

## 4. Secure-by-default for a public tool

A stranger's `npm i -g` must not create a foot-gun. Defaults:

| Setting | Default | Why |
|---|---|---|
| `SLACK_ALLOWED_USER_IDS` | **self only** (auto-detected in wizard) | Never `*` — a public default of "anyone in the workspace can run code on my box" is unacceptable (`02` §4, `04` §4). |
| Tool trust | **not** `ALL` | The user must consciously opt into full autonomy; wizard explains the risk. |
| Web UI bind | `127.0.0.1` only | No external exposure; `doctor` warns if changed. |
| Secrets | OS keychain | Not plaintext by default (`04` §1). |
| Startup warnings | on | `doctor` + startup flag any risky combo (allow-all + trust-all). |

`SECURITY.md` documents the threat model (this is remote code execution on your machine by design), the safe defaults, and how to report issues.

## 5. Versioning, releases, migration
- **Semver**, `CHANGELOG.md`, git tags, GitHub Releases.
- **Config schema `version`** (`01` §8, `04`): on upgrade, migrate `config.json`/pointer store forward automatically; never silently break an existing user's setup.
- CI: on tag, run tests + lint, publish to npm, cut a release. (Tests come from P0.)

## 6. Docs set (minimal but complete)
```
README.md            # curated front door (§3)
SECURITY.md          # threat model + safe defaults + reporting
docs/
  setup-slack.md     # app manifest + token steps (from 04 §4)
  brains.md          # per-brain notes + capability matrix
  web-cockpit.md     # tracking + web chat (03)
  troubleshooting.md # CA/TLS proxy, common errors, doctor
  evaluation.md …    # moved decision docs
CONTRIBUTING.md      # how to add a Brain / an Interface (points at 01 §3 / 02 §2 contracts)
```
`CONTRIBUTING.md` doubles as the extensibility proof: "adding a brain = implement the contract in `01`; adding an interface = implement the contract in `02`." That's the public payoff of the refactor.

## 7. Pre-public gate (checklist)
- [ ] **No secret in the entire git history** (re-run the full-history scan — already clean at push time; re-verify at release).
- [ ] `LICENSE` present (MIT — done).
- [ ] Secure defaults (§4) verified on a **clean Windows box and a clean macOS box**.
- [ ] `npm i -g <name>` → `cli-controller` → chatting-with-bot in ≤ 1 minute on both OSes (the `04` gate).
- [ ] README demo GIF + quickstart accurate against the shipped version.
- [ ] `cli-controller doctor` green on a correct setup; clear warnings on a risky one.
- [ ] `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md` present.
- [ ] Package name decided (§2); repo description + topics set on GitHub.
- [ ] Flip repo visibility to **public**.

## 8. Phasing (P6 — final; README curation can start earlier)
1. Package for npm (`bin`, `engines`, lean deps); `npx` works.
2. Secure-default pass + `SECURITY.md`.
3. Curated README + demo asset + `docs/` reorg.
4. Versioning/CHANGELOG/release CI + config migration.
5. Full-history secret re-scan + clean-box install tests (Win + mac).
6. Decide name → publish → flip to public.
