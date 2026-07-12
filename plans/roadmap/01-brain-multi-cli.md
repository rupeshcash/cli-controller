# 01 — Multi-CLI support via the Brain abstraction

> Workstream owner doc. Read [`README.md`](README.md) §2 (doctrine) and §5 (constraints) first.
> Outcome: **Kiro and Cline both run through one `Brain` interface behind one core**, choosable per session, with each tool's quirks (e.g. Kiro's resume-lock) hidden from the interface and the user.

---

## 1. What a "Brain" is

A **Brain** is an adapter around one AI coding CLI. It answers exactly one question for the core: *"run this turn in this workspace and give me the result, and tell me what you can and can't do."* It hides every tool-specific flag, session-file location, and quirk.

The current `slack-bridge/src/kiro.js` is, in effect, an un-abstracted Brain. Phase 1 extracts its shape into a contract and adds a second implementation (Cline) to prove the contract holds.

**Doctrine check:** we add the abstraction *because* a second CLI is genuinely coming (Cline), and we stop at two. We do not build a plugin loader or a registry DSL — brains are internal modules wired in a small map. Adding Claude Code / Codex later is "write one file + add one map entry," which is the correct amount of extensibility, not a marketplace.

## 2. Core extraction (the backbone P1 delivers)

Move the interface-agnostic, brain-agnostic logic out of `slack-bridge/src/index.js` into a `core/` module. Nothing user-visible changes in P1 — this is a pure refactor, verified by the existing Slack flow behaving identically.

```
core/
  brain/
    index.js          # Brain interface (JSDoc typedefs) + registry map
    kiro.js           # Kiro adapter (extracted from slack-bridge/src/kiro.js)
    cline.js          # Cline adapter (P2)
  session/
    store.js          # thread/session pointer store (from sessions.js) — store-agnostic
    capture.js        # new-session capture (the failure-safe logic from index.js)
    recent.js         # global session listing by reading native files (constraint #2)
  orchestrator.js     # runTurn(): pick brain, resume/fresh, capture, format hand-off
  routing/broker.js   # NL router (from broker.js) — now returns { brain, cwd, agent, model, prompt }
  config.js           # env + workspace registry loader/validator
  events.js           # tiny lifecycle event emitter (turn.started/completed/failed)
  format.js, chunk.js # output shaping (moved as-is)
```

`slack-bridge/` and `web-ui/` become **thin** — they translate their transport to/from core calls. `index.js` shrinks to Slack event handling + command parsing.

The broker's routing JSON gains one field: **`brain`** (`kiro` | `cline` | …), so "start a Cline session in X" routes correctly. Personal-UX: if the user doesn't say a tool, the broker uses the workspace's `defaultBrain` (from the workspace registry, `04`) or the global default — never asks.

## 3. The Brain contract

```ts
// Capability flags let the core and UI adapt instead of assuming Kiro semantics.
interface BrainCapabilities {
  resume: boolean;            // can continue a prior session by id?
  agents: boolean;            // has an "agent" concept?
  models: boolean;            // can pick a model per run?
  sessionStore: boolean;      // persists sessions on disk we can enumerate?
  singleWriterLock: boolean;  // only one live process per session (Kiro=true)?
  incrementalOutput: boolean; // emits usable output mid-run (almost always false today)?
}

interface RunTurnInput {
  cwd: string;
  sessionId: string | null;   // null => fresh session
  prompt: string;             // fed via stdin, never argv (constraint)
  agent?: string;
  model?: string;
  trust?: string;             // tool-specific trust/permission token
  timeoutMs?: number;         // 0 = none
  onSpawn?: (child) => void;  // for abort
  onData?: (chunk) => void;   // lifecycle/elapsed only unless incrementalOutput
  signal?: AbortSignal;
}

interface RunTurnResult {
  ok: boolean;
  output: string;
  error?: string;
  code?: number;
  sessionId?: string;         // resolved/created id (see capture)
}

interface Brain {
  id: string;                 // "kiro" | "cline"
  displayName: string;
  capabilities: BrainCapabilities;

  runTurn(input: RunTurnInput): Promise<RunTurnResult>;

  // Optional — presence is gated by capabilities; core/UI must tolerate absence.
  listSessions?(cwd: string): Promise<BrainSession[]>;      // reads native files
  listAgents?(cwd: string): Promise<string[]>;
  listModels?(): Promise<string[]>;
  captureNewSession?(cwd: string, beforeIds: Set<string>): Promise<string | null>;

  // Quirk hooks — the whole point of the abstraction (see §5).
  prepareResume?(sessionId: string): Promise<ResumePlan>;   // e.g. handle a live lock
  buildResumeCommand?(s: BrainSession): string;             // for "copy to resume" UX
  doctor?(): Promise<DoctorResult>;                         // install/auth checks (04)
}
```

The contract **encodes the constraints** so no consumer can forget them:
- Resume flags travel *inside* `runTurn`/`buildResumeCommand` — a consumer can never build a resume that drops `--agent` (constraint #3).
- `captureNewSession` carries the failure-safe rule (constraint #4): return a genuinely-new id or `null`, and it's called even on a failed fresh turn.
- `listSessions` is defined to read native files, not a cwd-scoped `list` (constraint #2).

## 4. Kiro adapter (extract, don't rewrite)

`core/brain/kiro.js` is the current `kiro.js` behind the contract:

```
capabilities = { resume:true, agents:true, models:true,
                 sessionStore:true, singleWriterLock:true, incrementalOutput:false }
runTurn      → spawn kiro-cli chat --no-interactive [--resume-id][--agent][--model]
               (--trust-all-tools | --trust-tools=…), prompt on stdin, ANSI strip
listSessions → read ~/.kiro/sessions/cli/*.json  (NOT --list-sessions)
listAgents   → kiro-cli agent list
listModels   → kiro-cli chat --list-models -f json
prepareResume→ inspect <id>.lock  (see §5)
buildResumeCommand → cd <cwd> && kiro-cli chat --agent <agent> --resume-id <id>
doctor       → is kiro-cli on PATH? is it authed?
```

Acceptance: the Slack flow behaves **byte-for-byte** as today with Kiro selected. This is the regression gate for the whole refactor.

## 5. Per-tool quirk handling (the Kiro resume-lock example)

The user's example is the canonical case: **Kiro will not resume a session while that session is still open/locked elsewhere** (`~/.kiro/sessions/cli/<id>.lock` + a live PID). Resuming a locked session from a second place produces stale/conflicting replies (the real bug behind "teleport picked a different conversation").

This is modeled as a **capability (`singleWriterLock`) + a `prepareResume` hook**, so the interface and web-ui never special-case Kiro:

```ts
// Kiro.prepareResume(sessionId):
const lock = readLock(sessionId);                 // {pid} | null
if (!lock) return { action: "ok" };
if (!isPidAlive(lock.pid)) return { action: "ok", note: "stale lock ignored" };
return { action: "blocked",
         reason: "This session is open in another live process (pid " + lock.pid + ").",
         options: ["wait", "force-takeover", "open-read-only-copy"] };
```

The orchestrator calls `prepareResume` before any resume. On `blocked`, it surfaces the reason to whichever interface asked, with the tool-appropriate options — e.g. web-ui shows a "session is live elsewhere — take over / cancel" prompt; Slack `!teleport` warns loudly (as it already does). **Force-takeover** = terminate the holding PID only after explicit user confirmation (destructive, never automatic). Brains without `singleWriterLock` (Cline, likely) return `{action:"ok"}` and the UI shows no such prompt. One code path, tool-correct behavior.

Other quirks are absorbed the same way: where transcripts live, whether `--agent` exists, trust-flag spelling, how a fresh session id appears. **Rule:** if a behavior differs per tool, it lives behind a capability flag or a hook — never in interface or web-ui code.

## 6. Cline as the first second Brain (Phase 2, fully functional)

**Start with a capability spike, not code.** Cline is primarily a VS Code extension; its headless/CLI surface must be verified before design. P2 opens with a short investigation that answers, from the actual `cline` CLI (not assumption):

| Question | Determines |
|---|---|
| Is there a non-interactive / headless run mode, and how is the prompt passed? | `runTurn` shape |
| Does it persist resumable sessions? Where? How addressed (id/path)? | `resume`, `sessionStore`, `listSessions` |
| Provider/model selection (API key vs subscription; which providers)? | `models`, onboarding (`04`) |
| Permission/tool-trust model (auto-approve vs ask)? | `trust` mapping, safety defaults |
| One-writer lock semantics? | `singleWriterLock`, `prepareResume` |
| Does it emit incremental output on a pipe? | `incrementalOutput` (expect false) |
| Auth/install check for `doctor`. | `04` onboarding |

The spike's output is a filled-in `BrainCapabilities` for Cline + notes. Only then implement `core/brain/cline.js` to the contract. Where Cline lacks a capability (e.g. no agents), the flag is `false` and every consumer already tolerates its absence (that's what the optional methods are for).

"Fully functional" acceptance for Cline:
- Start a fresh Cline session from Slack **and** web, in a chosen workspace, with a chosen model/provider.
- Continue it (if Cline supports resume) via the same thread / web session; if it doesn't, the UI honestly shows "this tool doesn't support resume" instead of pretending.
- Output formatting, chunking, snippet-upload, abort, and status reactions work identically to Kiro (they're core, not Kiro-specific).
- Normalized into the same session store / web cockpit as Kiro sessions, tagged by brain.

## 7. Capability matrix (Kiro verified; Cline verified via P2 spike 2026-07-11)

| Capability | Kiro (verified) | Cline (verified) | Claude Code (later) | Codex (later) |
|---|---|---|---|---|
| resume | ✅ `--resume-id` | ✅ `--id <session-id>` | ? | ? |
| agents | ✅ `agent list` | ❌ (has plan/act modes, not named agents) | ? | ? |
| models | ✅ | ✅ `-m` model, `-P` provider, `-k` key, `auth` | ? | ? |
| sessionStore (enumerable) | ✅ `~/.kiro/sessions/cli/*.json` | ✅ `cline history --json` (data at `~/.cline`) | ? | ? |
| singleWriterLock | ✅ (`.lock` + PID) | ❌ (no per-session PID lock; `--data-dir` isolation + optional `-z` hub) | ? | ? |
| incrementalOutput | ❌ | ⏳ likely ✅ via `--json` (line-delimited events) — **verify in adapter**; would make Cline the first streaming brain | ? | ? |

### 7.1 Cline spike findings (2026-07-11, cline v3.0.39, official `npm i -g cline`)
- **Headless by default:** `cline [prompt]` runs in act mode, auto-approve on; TUI is opt-in (`-i`). `--json` emits machine-readable messages. Non-interactive `config` needs a TTY → configure via flags / `auth` / settings files, not `cline config`.
- **runTurn mapping:** `cline -c <cwd> --json [--id <id>] [-P <provider>] [-m <model>] [--auto-approve <bool>] [-t <secs>] "<prompt>"`. Verify stdin prompt support; positional prompt works.
- **trust mapping:** `--auto-approve <boolean>` (default true) ↔ our `trust`. Safety: default the adapter to a conservative value unless the user opts in (doctrine + `05` secure defaults).
- **listSessions:** `cline history --json --limit N`. **prepareResume:** no lock semantics → returns `{action:"ok"}` (so web/Slack never show the take-over prompt for Cline).
- **doctor:** `cline doctor` (also reports a background "hub" for `-z` sessions).
- **Blocking dependency for a live turn:** a provider must be authenticated (`cline auth`; default provider `cline` needs login, or bring an API key). This is an onboarding step (`04`); P2's "fully functional" live-run acceptance depends on it.

## 8. Store ownership (settles the SQLite question early)

- **Native tool session files are the source of truth for conversation content.** The core never rewrites them.
- The bridge pointer store (`state.json`) maps `interface-thread → { brain, cwd, sessionId, agent, model, … }`. It gains a **`brain`** field and a **schema `version`**.
- When search arrives (`03`), SQLite is a **derived, rebuildable index** of metadata across brains — never authoritative for transcripts; `doctor --reindex` rebuilds it from native files. This kills the drift class we already see between `--list-sessions` and the `.json` files.

## 9. Phasing

**P1 — Extract core (no behavior change).**
1. Create `core/`; move `sessions.js`, `broker.js`, `chunk.js`, `format.js`, capture + recent logic, config.
2. Define the `Brain` contract; implement `kiro.js` behind it.
3. `slack-bridge` calls `core.orchestrator.runTurn()` instead of `runKiro()` directly.
4. Add `brain` + `version` fields to the pointer store (default `kiro`, migrate on read).
5. Gate: Slack + Kiro behaves identically; add unit tests for capture-on-failure, command parsing, routing JSON.

**P2 — Cline Brain.**
1. Capability spike (§6) → fill matrix + capabilities.
2. Implement `cline.js` to contract; wire into the brain map + broker `brain` field.
3. Per-session brain selection in Slack (`!new brain=cline …`, or NL) and web (tool picker).
4. Gate: the "fully functional" acceptance list in §6, on Windows and macOS.

**Cross-cutting acceptance:** no interface or web-ui file contains a `if (brain === 'kiro')` branch — all divergence is behind capabilities/hooks.
