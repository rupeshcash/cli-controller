# Kiro via Slack — Tutorial (thread = session)

DM the **supportGPT** bot. The model is simple:

- **Send any message** → starts a new session; the bot runs it and **replies in a thread**.
- **Reply inside that thread** → same Kiro session continues (no command needed).
- **Each new top-level message = its own session** → as many parallel threads as you want.
- Default agent is **`main`**; default directory is set in `.env`.

## Start a session (just type)

Top-level message — no command needed:
```
add pagination to the /users endpoint
```
The bot replies in a thread using agent `main` and the default directory.

### Override agent / dir / model at start
Use `!new` only when you want to override defaults:
```
!new agent=my-agent dir=~/projects/api  add pagination to the /users endpoint
```
- `agent=` optional (omit → `main`). See choices with `!agents`.
- `dir=` optional (omit → default dir). Accepts `~`.
- Everything after the options is your first prompt. You can also send just `!new` (no task) to open an empty thread and start typing in it.

The bot replies **in a thread** on that message. That thread is now your session.

## Continue a session

Just **reply in the thread**. No `!` needed. Full context carries over (Kiro resumes the session each turn). Continue as long as you like.

## Run multiple sessions at once

Send several top-level `!new …` messages — each opens its own thread/session, and they can run **in parallel** (one task at a time *per thread*).

Example:
```
!new dir=~/projects/api      fix the failing auth test
!new dir=~/projects/web      bump the tailwind version and rebuild
```
→ two independent threads, two independent Kiro sessions.

## Terminal → Slack

| Terminal | Slack |
|---|---|
| `cd ~/api && kiro-cli chat` | `!new dir=~/api <task>` |
| `kiro-cli chat --agent X` | `!new agent=X <task>` |
| type follow-up questions | reply in the thread |
| new unrelated task | new top-level `!new …` (new thread) |
| `kiro-cli agent list` | `!agents` |
| Ctrl-C | `!abort` (inside the thread) |
| — | `!status` (inside the thread), `!help` |

## Commands

| Where | Command | Action |
|---|---|---|
| Top level | *(any message)* | Start a new session (agent `main`), reply in a thread |
| Top level | `!new [agent=..] [dir=..|<alias>] [model=..] <task>` | Start a new session with overrides |
| Anywhere | `!help` | Show help |
| Anywhere | `!agents` | List available agents |
| In a thread | `!status` | Show that session's dir / agent / model / id |
| In a thread | `!abort` | Stop the running task in that thread |
| In a thread | `!model <name>` | Change model for the next turn (`!model clear` → default) |
| In a thread | `!agent <name>` | Change agent for the next turn |
| In a thread | `!end` (or `!done`) | Close the session for that thread |
| In a thread | `!clear` (or `!reset`) | Start a fresh session in the same thread |

## Status reactions

The bot marks **your message** with a reaction: ⏳ while working → ✅ done / ❌ error. (Requires the `reactions:write` scope; without it, it posts a short "working…" note instead.)

## Directory aliases

Set aliases in `.env`:
```
KIRO_DIR_ALIASES=api:~/projects/api,web:~/projects/web
```
Then start fast:
```
!new api  fix the failing auth test
```
(`api` resolves to `~/projects/api`.) Aliases also work as `dir=api`.

## Timeouts

Each turn is capped by `KIRO_TIMEOUT_MS` in `.env` (default `300000` = 5 min). Set `KIRO_TIMEOUT_MS=0` for **no timeout** (long autonomous runs).

## Large text — ✅
Paste a big prompt as **one** message (top-level with `!new`, or one thread reply). Practical ceiling ≈ Slack's ~40k chars/message. For more, put it in a file inside `dir` and ask Kiro to read it. Long replies auto-split `(1/n)`.

## Images — ❌ (not yet)
`kiro-cli` headless has no image input, so images can't be forwarded to Kiro. Text/code files on disk can be referenced by path in a prompt.

## Notes
- One task at a time **per thread**; different threads run in parallel. `!abort` cancels the current one in a thread.
- Sessions + their thread mapping persist to `state.json`, so **restarting the bridge keeps every thread's session** alive.
- 5-min per-turn cap (safety). Full autonomy (`--trust-all-tools`) is on — keep the workspace private to you.

## Manage the bridge
```bash
tail -f cli-controller/slack-bridge/bridge.log          # logs
kill "$(cat cli-controller/slack-bridge/bridge.pid)"     # stop
cd cli-controller/slack-bridge && nohup bash run.sh > bridge.log 2>&1 & echo $! > bridge.pid   # start
```

## Output, tool activity & context

- **You see what Kiro does.** The bridge forwards Kiro's headless stdout, which includes its **tool activity** — the commands it runs, directories/files it reads, and completion times — followed by the final answer. It reads much like your TUI session (minus the live-redrawing chrome).
- **Formatted for Slack.** Kiro's Markdown is converted to Slack formatting (headings/`**bold**` → bold, `-` → •, `[text](url)` → links) and tool lines are shown compactly (`🔧` command, `📂` dir, `📄` file, `⏱` time). Code blocks are preserved verbatim.
- **Long output → file snippet.** If a response exceeds `KIRO_SNIPPET_THRESHOLD` chars (default 12000), it's uploaded to the thread as a `kiro-response.md` file instead of many chunked messages. Requires the `files:write` scope.
- **Context size.** `!status` (in a thread) shows `turns` (message count) for the session as a rough size indicator.
- **The live `◕ NN%` context meter is _not_ available.** That percentage is drawn by Kiro's interactive TUI and is not emitted in headless (`--no-interactive`) output — so it can't be piped to Slack today. Getting the real meter would require running Kiro inside a pseudo-terminal and scraping the TUI status bar (a larger change with reliability tradeoffs). `turns` is the honest proxy for now.
