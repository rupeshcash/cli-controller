# Security

## Threat model (read this)

cli-controller lets you trigger an AI coding agent — which can **read, write, and run commands** on your machine — from a chat message. That is remote code execution on your own box, by design. Treat it accordingly.

The two controls that matter:

| Control | Env | Safe default | Risk if loosened |
|---|---|---|---|
| **Who may trigger runs** | `SLACK_ALLOWED_USER_IDS` | your own Slack user id (set by the setup wizard) | `*` lets *anyone in the workspace* run code on your machine — never use it on a shared workspace |
| **What tools the agent may use without asking** | `KIRO_TRUST_TOOLS` | `fs_read` (read-only) | `ALL` = the agent runs shell commands / edits files with no confirmation |

`cli-controller doctor` warns when both are loosened at once. Startup config validation refuses to boot only on missing tokens; it warns (does not block) on risky combos so a deliberate private sandbox still runs.

## Defaults enforced

- Setup wizard sets the allow-list to **just you** (auto-detected via `auth.test`) — never `*`.
- Tool trust is **opt-in**; the default is read-only.
- The web cockpit binds to **`127.0.0.1`** only. Do not expose it without adding auth in front.
- Secrets (Slack tokens) are written to `slack-bridge/.env` with **owner-only (0600)** permissions and are gitignored. No secret is ever committed.
- The prompt is delivered to the CLI via **stdin**, and all child processes are spawned with argument arrays (never a shell string) — no command injection.

## Handling secrets

`.env`, `state.json`, `*.log`, `*.pid`, `macos-ca.pem`, and `~/.cli-controller/` never belong in git. The `.gitignore` enforces this; verify with `git status` before committing.

## Reporting a vulnerability

Open a GitHub issue marked **security**, or contact the maintainer privately. Please do not include real tokens or session transcripts in a public issue.
