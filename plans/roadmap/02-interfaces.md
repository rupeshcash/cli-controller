# 02 — Multi-interface support + Slack improvements

> Read [`README.md`](README.md) §2 (doctrine) first.
> Outcome: **Slack and the web cockpit are peer Interfaces over the core**, adding a future interface (Telegram/REST) is a new file rather than a rewrite, and **Slack works in channels, not just bot DMs.** No new interface is built now — this is refactor + the Slack channel win.

---

## 1. What an "Interface" (Controller) is

An **Interface** adapter translates one front-end's transport into core calls and renders core results/events back. It answers: *"a human sent this text targeting this conversation"* → core, and *"the core produced this result/status"* → back to that conversation.

Doctrine check: we refactor Slack into this shape and make web a peer **because the core extraction (`01`) already forces a clean boundary** — so the marginal cost is small and it removes Kiro/Slack assumptions from each other. We do **not** build Telegram/REST now. The test of "did we refactor enough" is simply: *could a new interface be added as one file without touching core or brains?* If yes, stop.

## 2. The Interface contract

```ts
interface IncomingMessage {
  interface: string;              // "slack" | "web"
  conversationKey: string;        // stable per-thread key (see §4) → maps to a session
  userId: string;                 // for allow-list / ownership
  text: string;
  isThreadReply: boolean;         // continue vs start
  raw?: unknown;                  // transport-specific escape hatch
}

interface OutgoingMessage {
  conversationKey: string;
  text?: string;                  // markdown; interface renders to its own format
  file?: { name: string; content: string };   // long output as attachment
  status?: "working" | "done" | "error";       // reaction/badge
}

interface Interface {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (m: IncomingMessage) => Promise<void>): void;
  send(msg: OutgoingMessage): Promise<void>;
  onLifecycle?(event: LifecycleEvent): void;   // turn.started/completed/failed + elapsed
}
```

The core's orchestrator already produces `RunTurnResult` and lifecycle events (`01` §2); each interface just renders them. **Constraint #1 lives here too:** `onLifecycle` carries *events and elapsed time*, not streaming content — so no interface promises live output the brain can't provide.

## 3. Refactoring Slack into an Interface

`slack-bridge/src/index.js` today mixes Slack transport, command parsing, allow-list, session pointing, and orchestration. Split it:

- **`interfaces/slack/`** — Bolt app, event subscriptions, allow-list, reaction/status rendering, chunking to Slack, `send()`/`onMessage()`. Transport only.
- **Command parsing** (`!new`, `!teleport`, quick aliases, in-thread commands) → these are *core* commands expressed over any interface; move the parser to `core/commands.js` so web can reuse them. Slack just forwards raw text and renders results.
- **Everything else** (routing, brain, capture, format) already moved to core in `01`.

Acceptance: identical Slack behavior, but `index.js` is now a thin transport + render layer.

## 4. Slack channel support (the headline Slack win)

**Today:** the bridge only handles `message.im` — it works in the bot's DM tab, not in channels. This is the biggest Slack limitation.

**Target:** work in **DMs, public channels, and private channels**, keeping the thread=session model and *not* becoming a noisy bot that replies to everything.

### Behavior rules (personal-UX-first)

| Context | Start a session (top-level) | Continue (thread reply) |
|---|---|---|
| **DM with bot** | any message (as today) | any reply (as today) |
| **Channel (public/private)** | **@mention the bot** (`@cli-controller fix the flaky test in api`) | any reply in that thread — **no mention needed** |

Rationale: in a shared/multi-purpose channel the bot must not treat every message as a task — an explicit `@mention` is the intent signal to *start*. Once a thread is its session, replies flow naturally (same great thread UX). In a DM nothing changes.

### What this requires

1. **Slack app scopes/events:** add `app_mention`, `message.channels` (public), `message.groups` (private), keep `message.im`; bot must be invited to the channel. Document in `SETUP.md`.
2. **Event handling:** treat `app_mention` (or a channel message that mentions the bot, stripped of the mention) as a top-level start; `message.*` thread replies whose `thread_ts` maps to a known session as a continue. Ignore un-mentioned, non-thread channel chatter.
3. **conversationKey** stays `"<channel>:<thread_ts>"` — already channel-aware, so the session model needs no change. Threads started from a channel root work exactly like DM threads.
4. **Allow-list in channels:** `SLACK_ALLOWED_USER_IDS` still gates *who* can trigger runs — critical, because a channel may contain people who should not drive your machine. A channel message from a non-allowed user that mentions the bot gets a polite "not authorized" (or silent ignore, configurable). This is a safety-sensitive default: **channel support must not widen who can execute code.**
5. **Mention hygiene:** strip the `<@BOTID>` token before the text reaches the broker/prompt.

### Non-goals for channels (now)
- No slash commands / interactive buttons / modals yet (that's a later Slack-UX polish; see `03`/backlog). Channel support is purely: mention-to-start, reply-to-continue, allow-list enforced.

## 5. Web as a peer Interface

The web cockpit (`03`) becomes a real Interface, not just a viewer:
- Its "start session" form and per-session "continue" composer produce `IncomingMessage`s into the same core `onMessage` path Slack uses.
- Core results/lifecycle render into the browser (via SSE — lifecycle + elapsed, per constraint #1).
- A session started in Slack can be continued from web and vice-versa, because both are interfaces over the *same* core session (this is the "handoff" payoff — one session, multiple interface links). The pointer store records which interface-threads link to a session.

## 6. Future interfaces (design only — not built)

Telegram (official Bot API — free, no ban risk) and a REST API are the natural next interfaces. The contract in §2 is deliberately shaped so each is **one file** under `interfaces/`:
- Telegram: map chat/thread ids → `conversationKey`, render markdown to Telegram, poll or webhook.
- REST: `POST /sessions`, `POST /sessions/:id/turns`, etc. — thin mapping to core.

**WhatsApp is explicitly excluded** except via the official Cloud API (business number + Meta review); the unofficial route is banned by this project's founding decision (`../../evaluation.md`). Do not add it to satisfy "more interfaces."

## 7. Phasing (P3, parallelizable with P2)

1. Extract `interfaces/slack/`; move command parsing to `core/commands.js`; verify identical behavior.
2. Add channel scopes/events; implement mention-to-start + thread-reply-to-continue; enforce allow-list in channels; update `SETUP.md`.
3. Make web emit `IncomingMessage` into core (depends on `03` composer) + render lifecycle via SSE.
4. Gate: start a session by @mentioning the bot in a channel, continue it by replying (no mention), on Windows and macOS; a non-allowlisted channel member cannot trigger a run; DM behavior unchanged; no `if (interface==='slack')` branches in core or brains.
