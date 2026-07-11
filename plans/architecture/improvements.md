# cli-controller Product Improvements

> Work item: `architecture`  
> File: `plans/architecture/improvements.md`  
> Goal: identify what needs to improve for `cli-controller` to become a genuinely good, extensible product rather than a useful one-off local bridge.

---

## 1. Product vision

`cli-controller` should evolve from:

> A Slack bridge for controlling Kiro CLI.

into:

> A local-first control plane for developer AI agents, where multiple controllers can operate multiple CLI-based AI coding tools through a clean, extensible architecture.

In short:

```text
Today:
Slack -> Kiro CLI

Future:
Slack / Web / Telegram / WhatsApp / REST API / IDE
  -> controller layer
  -> core orchestration layer
  -> AI tool adapter layer
  -> Kiro / Cline / Claude Code / Codex / Gemini / custom CLIs
```

The product should become a **developer AI session hub**.

---

## 2. Your improvement ideas

### 2.1 Support more CLIs, not only Kiro CLI

Current limitation:

- The system is tightly built around `kiro-cli`.
- The Kiro integration assumes Kiro-specific concepts:
  - `kiro-cli chat`
  - `--resume-id`
  - `--no-interactive`
  - `--trust-tools`
  - `kiro-cli agent list`
  - `kiro-cli chat --list-sessions`
  - Kiro session files under `~/.kiro/sessions/cli`

Desired improvement:

- Add support for additional AI coding CLIs, especially:
  - Cline CLI
  - Claude Code CLI
  - Codex CLI
  - Gemini CLI
  - custom/internal AI tools

Product-level goal:

```text
The user should be able to choose the AI tool per session.
```

Example user requests:

```text
Start a Cline session in cli-controller.
Start a Kiro session in java-utils with Opus.
Continue this old Claude Code session.
Use Codex to review this repo.
```

Architecture implication:

- Introduce a pluggable **AI Tool Adapter** interface.

Conceptual interface:

```ts
interface AiToolAdapter {
  id: string;
  displayName: string;

  startTurn(input: RunTurnInput): Promise<RunTurnResult>;

  listSessions?(query: SessionQuery): Promise<AiSession[]>;
  resumeSession?(sessionId: string, input: RunTurnInput): Promise<RunTurnResult>;
  listAgents?(): Promise<Agent[]>;
  listModels?(): Promise<Model[]>;
  validateConfig?(): Promise<ValidationResult>;
}
```

---

### 2.2 Support more controllers, not only Slack bridge

Current limitation:

- The primary controller is Slack.
- The web UI mostly observes and controls the Slack bridge.
- There is no clean abstraction for Telegram, WhatsApp, Discord, REST API, IDE extensions, local TUI, etc.

Desired improvement:

- Treat Slack as one controller among many.

Possible future controllers:

| Controller | Purpose |
|---|---|
| Slack | Remote control from phone/workspace. |
| Web | Full developer dashboard and session control. |
| Telegram | Lightweight mobile chat control. |
| WhatsApp | Mobile control where WhatsApp is preferred. |
| Discord | Community/team-style control. |
| REST API | Programmatic automation and integration. |
| Local terminal TUI | Keyboard-first local control. |
| IDE extension | VS Code/Cursor/Kiro IDE-style integration. |

Architecture implication:

- Introduce a pluggable **Controller Adapter** interface.

Conceptual interface:

```ts
interface ControllerAdapter {
  id: string;
  displayName: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  onUserMessage(handler: ControllerMessageHandler): void;
  sendMessage(target: ControllerTarget, message: ControllerResponse): Promise<void>;
  sendStatus?(target: ControllerTarget, status: RunStatus): Promise<void>;
}
```

---

### 2.3 Make the web UI sticky-helpful for developers

Current limitation:

- The UI is useful for viewing sessions and bridge status.
- But it is not yet a strong daily developer workspace.
- It does not yet let the developer fully search, understand, start, continue, and manage sessions from the browser.

Desired improvements:

#### Natural-language session search

The developer should be able to ask:

```text
show me sessions where I fixed auth issues
find the session where we discussed Slack Socket Mode
which sessions touched java-utils last week?
show failed or aborted runs
show sessions with high context usage
```

This requires:

- Indexing session metadata.
- Optional indexing of transcript/session content.
- Full-text search at minimum.
- Semantic search later.
- Filters by:
  - repo
  - tool
  - controller/source
  - agent
  - model
  - date
  - message count
  - context usage
  - status

#### Start sessions from web

The web UI should allow:

```text
New session
  Tool: Kiro / Cline / Claude Code / Codex
  Repo: select from known workspaces
  Agent: select
  Model: select
  Prompt: textarea
```

#### Continue sessions from web

The session detail page should allow:

```text
Continue this session:
[ prompt box ]
[ run ]
```

The result should stream or appear in the browser, and optionally mirror to Slack/Telegram if the session is linked.

#### Better session detail

The session detail page should show:

- Full transcript.
- Tool calls.
- Files touched.
- Commands run.
- Errors.
- Timeline.
- Cost/tokens/context if available.
- Resume command.
- Linked controller threads.
- Notes/tags.

#### Developer-friendly persistence

The UI should remember:

- Last selected repo.
- Last selected tool.
- Favorite sessions.
- Pinned workspaces.
- Filters.
- Recently used prompts.
- Saved prompt templates.

---

### 2.4 Decouple the architecture

Current limitation:

- The architecture is coupled:
  - Slack message logic knows too much about Kiro.
  - Web UI knows about Kiro session files and bridge state.
  - `kiro.js` is not an interchangeable adapter.
  - State model is built around Slack thread -> Kiro session.
  - Lifecycle control is script/process-specific.

Desired improvement:

Separate the system into clear layers:

```text
Controllers
  -> Core orchestration
  -> Tool adapters
  -> Local AI CLIs
```

Target shape:

```text
controllers/
  slack/
  web/
  telegram/
  whatsapp/
  rest-api/

core/
  sessions/
  routing/
  orchestration/
  permissions/
  events/
  config/
  logging/

tools/
  kiro/
  cline/
  claude-code/
  codex/

storage/
  sqlite/
  files/
  search-index/
```

The core should not care whether a request came from Slack, web, Telegram, or an API.

A controller should not care whether a run is performed by Kiro, Cline, Claude Code, Codex, or another tool.

---

## 3. Additional improvement ideas

### 3.1 Introduce a real core domain model

Right now, important concepts are implicit in files, Slack handlers, and Kiro-specific helpers.

Define first-class domain objects:

```text
User
Controller
Workspace
AiTool
Session
Turn
Run
Message
Artifact
ToolCall
Event
```

Example:

```text
Session
  id
  title
  workspaceId
  toolId
  controllerLinks[]
  currentStatus
  createdAt
  updatedAt

Turn
  id
  sessionId
  prompt
  response
  status
  startedAt
  completedAt
  toolCalls[]
  artifacts[]
```

Why this matters:

- Enables multi-tool support.
- Enables multi-controller support.
- Makes web search easier.
- Makes session handoff possible.
- Makes persistence cleaner.
- Makes analytics possible.

---

### 3.2 Add a central session database

Current state is split across:

- `slack-bridge/state.json`
- Kiro session files
- log files
- pid files
- in-memory maps

For product quality, add a small local database.

Recommended option:

```text
SQLite
```

Why SQLite:

- Local-first.
- No service dependency.
- Easy backups.
- Good enough for thousands of sessions.
- Supports indexing and search extensions.
- Works cross-platform.

Possible tables:

```text
sessions
turns
messages
controller_links
tool_runs
workspaces
ai_tools
events
artifacts
settings
```

The system can still read native Kiro session files, but should maintain its own normalized product state.

---

### 3.3 Add search as a central product feature

Search should be a first-class capability, not an afterthought.

Levels:

#### Level 1 — Metadata search

Search by:

- title
- cwd
- repo name
- agent
- model
- source/controller
- date
- status

#### Level 2 — Transcript search

Search inside prompts/responses.

#### Level 3 — Semantic search

Search by meaning:

```text
that session where we debugged auth middleware
```

Possible implementation:

- SQLite FTS5 for text search.
- Optional embeddings for semantic search.
- Background indexer for tool transcripts.
- Incremental indexing after each turn.

---

### 3.4 Make web a first-class controller

The web UI should not be only an observer.

It should become:

```text
A full AI coding session cockpit.
```

Features:

- Start session.
- Continue session.
- Stop/abort run.
- Switch model/agent/tool.
- Attach to existing Slack session.
- Detach from Slack.
- View live output.
- View run history.
- Add notes/tags.
- Compare sessions.
- Export transcript.
- Open workspace in editor.
- Open changed files.

---

### 3.5 Add real-time updates

Current UI polls APIs, and Slack receives final responses.

A product-grade system should support real-time updates.

Options:

- Server-Sent Events.
- WebSocket.
- Event bus in core.
- Log/event streaming from tool adapters.

Desired UX:

```text
Prompt submitted
  -> run started
  -> tool call started
  -> command output
  -> file edited
  -> response streaming
  -> run completed
```

This would make the web UI feel alive and make long-running tasks easier to trust.

---

### 3.6 Improve process and run management

Current model:

- One child process per turn.
- In-memory `running` map.
- PID files for bridge/panel.
- Bash lifecycle scripts.

Needed improvements:

- Cross-platform process manager.
- Persistent run records.
- Run status survives controller restart.
- Kill process tree reliably on Windows/macOS/Linux.
- Better timeout handling.
- Queue or concurrency limits.
- Per-workspace locking.
- Run retry strategy.
- Zombie process detection.
- Structured run logs.

---

### 3.7 Add permission and safety model

Current safety is mostly:

- Slack allow-list.
- Kiro trust tools setting.

Product-grade safety should answer:

```text
Who can run what, where, using which tools, with what permissions?
```

Suggested model:

| Concept | Example |
|---|---|
| User | Slack user, web user, API token owner |
| Workspace permission | Can access repo A, not repo B |
| Tool permission | Can use Kiro, cannot use shell-enabled tool |
| Action permission | Can read files, edit files, run commands |
| Approval policy | Auto-approve reads, ask before writes/commands |
| Environment | personal laptop, work laptop, sandbox |

Possible policy example:

```yaml
users:
  U123:
    workspaces: [cli-controller, java-utils]
    tools: [kiro, cline]
    maxTrust: fs_read
```

---

### 3.8 Add authentication for the web UI

Currently, the web UI is localhost-only and unauthenticated.

That is acceptable for a local utility, but not for a product.

Options:

- Local password.
- Magic local token.
- OS keychain-backed token.
- GitHub OAuth.
- Slack login.
- Tailscale identity if remote.

At minimum:

- Keep bound to `127.0.0.1`.
- Warn if bound externally.
- Require auth if exposed beyond localhost.

---

### 3.9 Add workspace registry

Today workspaces come from:

- `KIRO_DEFAULT_CWD`
- `KIRO_DIR_ALIASES`
- ad hoc paths

A product should have a workspace registry:

```yaml
workspaces:
  cli-controller:
    path: C:\Users\rupes\Desktop\work\cli-controller
    defaultTool: kiro
    defaultAgent: main
    defaultModel: claude-sonnet-5
    tags: [personal, node, controller]

  java-utils:
    path: C:\Users\rupes\Documents\armorcode-2026\java-utils
    defaultTool: cline
    defaultAgent: main
    tags: [work, java]
```

Benefits:

- Easier UI selection.
- Safer routing.
- Better search filters.
- Cleaner natural-language routing.
- Per-workspace permissions.

---

### 3.10 Add session handoff across controllers

A strong product feature would be:

```text
Start in Slack -> continue in Web -> monitor from phone -> resume in terminal.
```

This requires controller links:

```text
sessionId
  linked to Slack thread
  linked to web conversation
  linked to terminal resume command
```

The product should treat Slack thread IDs, Telegram chat IDs, browser session IDs, etc. as links to the same core session.

---

### 3.11 Add event-driven architecture

Instead of direct calls everywhere, the core should emit events:

```text
session.created
turn.started
tool.output
tool.error
turn.completed
session.linked
session.archived
```

Controllers subscribe and render events in their own way.

Example:

```text
Core emits: turn.completed

Slack controller:
  posts response in thread

Web controller:
  updates run timeline

REST controller:
  exposes completed status

Logger:
  writes structured log
```

This decouples the product heavily.

---

### 3.12 Add observability

Needed for real usage:

- Structured logs.
- Request IDs / run IDs.
- Per-turn duration.
- Tool exit code.
- Error category.
- Last successful run.
- Session count.
- Active run count.
- Failed run count.
- Token/context stats if available.

Dashboard should show:

```text
Health
Active runs
Recent failures
Slow sessions
High-context sessions
Tool availability
Config warnings
```

---

### 3.13 Add onboarding/setup wizard

Current setup requires manual `.env` editing and Slack app setup knowledge.

Product-grade onboarding:

- Detect installed AI CLIs.
- Verify Slack tokens.
- Verify Socket Mode.
- Verify workspace paths.
- Verify Kiro/Cline auth status.
- Create sample workspace.
- Run smoke test.
- Show warnings:
  - allow-all
  - trust-all
  - missing paths
  - unreachable CLI
  - invalid tokens

Could be available in:

```text
web-ui /setup
```

or:

```bash
cli-controller doctor
```

---

### 3.14 Add `doctor` command

A product-quality local tool needs diagnostics.

Example:

```bash
cli-controller doctor
```

Checks:

- Node version.
- npm install status.
- Slack env variables present.
- Slack auth works.
- Kiro CLI installed.
- Cline CLI installed.
- Config paths exist.
- Dashboard port available.
- Bridge process status.
- File permissions.
- Session store readable.
- Security warnings.

Example output:

```text
✓ Node v22
✓ Slack bot token present
✓ Kiro CLI found
✗ Cline CLI not found
⚠ SLACK_ALLOWED_USER_IDS=*
⚠ KIRO_TRUST_TOOLS=ALL
✗ java-utils path does not exist
```

---

### 3.15 Add plugin system later

If the long-term goal is multiple tools and multiple controllers, define plugin contracts early.

Plugin types:

```text
Tool plugin
Controller plugin
Storage plugin
Search plugin
Auth plugin
Renderer plugin
```

Possible folder:

```text
plugins/
  tools/
    kiro/
    cline/
  controllers/
    slack/
    telegram/
    web/
```

Important: avoid over-engineering at first. Start with internal adapters, then external plugins later.

---

### 3.16 Improve Slack UX

Slack can become much better:

- Home tab showing sessions.
- Slash commands:
  - `/ai new`
  - `/ai recent`
  - `/ai continue`
- Interactive buttons:
  - Abort
  - Continue
  - Open in Web
  - Change model
- Modals for new session setup.
- Better session cards.
- Link from Slack session to web dashboard.
- Thread title updates.
- Per-run progress updates.

---

### 3.17 Improve web UX

Potential improvements:

- Command palette.
- Natural-language search bar.
- Session timeline.
- Run timeline.
- Transcript viewer.
- Prompt composer.
- Workspace switcher.
- Tool switcher.
- Model/agent picker.
- Tags/favorites.
- Continue-here button.
- Send-this-session-to-Slack button.
- Open-in-editor button.
- Files-touched panel.
- Commands-run panel.
- Errors panel.
- High-context warning.
- Session compaction/summarization.

---

### 3.18 Add REST API

A REST API would make the product scriptable and help decouple the web UI from local files.

Possible endpoints:

```text
POST /api/sessions
POST /api/sessions/:id/turns
POST /api/runs/:id/abort
GET  /api/sessions
GET  /api/sessions/:id
GET  /api/runs/:id
GET  /api/workspaces
GET  /api/tools
GET  /api/controllers
```

---

### 3.19 Add background indexer

A background service should index:

- Kiro session files.
- Cline sessions.
- Tool transcripts.
- Run logs.
- Workspace metadata.
- Git info.

This powers:

- Search.
- Analytics.
- Session detail.
- Recommendations.
- Routing.

---

### 3.20 Add artifacts and file-change tracking

For coding agents, the most useful question is often:

```text
What changed?
```

Track:

- Files read.
- Files edited.
- Commands run.
- Tests run.
- Test failures.
- Git diff before/after.
- Generated files.
- Logs attached.

Session detail should show these as artifacts.

---

## 4. Proposed decoupled architecture

```mermaid
flowchart TB
  subgraph Controllers
    Slack[Slack controller]
    Web[Web controller]
    Telegram[Telegram controller]
    WhatsApp[WhatsApp controller]
    API[REST API controller]
  end

  subgraph Core
    Router[Request router]
    Orchestrator[Session orchestrator]
    Policy[Permission and policy engine]
    SessionStore[Session store]
    EventBus[Event bus]
    Search[Index and search service]
  end

  subgraph ToolAdapters
    Kiro[Kiro adapter]
    Cline[Cline adapter]
    Claude[Claude Code adapter]
    Codex[Codex adapter]
    Gemini[Gemini adapter]
  end

  subgraph Storage
    SQLite[(SQLite)]
    Files[(Native tool session files)]
    Index[(Search index)]
  end

  Slack --> Router
  Web --> Router
  Telegram --> Router
  WhatsApp --> Router
  API --> Router

  Router --> Policy
  Policy --> Orchestrator
  Orchestrator --> SessionStore
  Orchestrator --> EventBus
  Orchestrator --> Kiro
  Orchestrator --> Cline
  Orchestrator --> Claude
  Orchestrator --> Codex
  Orchestrator --> Gemini

  SessionStore --> SQLite
  Search --> SQLite
  Search --> Index
  Kiro --> Files
  Cline --> Files
  Claude --> Files
```

---

## 5. Suggested staged roadmap

### Stage 0 — Stabilize current product

Goal: make today's Slack + Kiro + web setup reliable.

Work:

1. Cross-platform process status/control.
2. Config validation.
3. Startup doctor.
4. Safer defaults/warnings.
5. Better logs.
6. Basic tests for parsing and state logic.

---

### Stage 1 — Extract core

Goal: separate Slack from Kiro logic.

Work:

1. Create `core/`.
2. Move session model into core.
3. Move run orchestration into core.
4. Keep Kiro as first tool adapter.
5. Keep Slack as first controller adapter.
6. Make web talk to core API instead of reading files directly.

---

### Stage 2 — Make web a real controller

Goal: web can start and continue sessions.

Work:

1. New session form.
2. Continue session composer.
3. Live run status.
4. Abort from web.
5. Transcript viewer.
6. Session search.

---

### Stage 3 — Add second AI tool

Goal: prove adapter architecture.

Recommended first second tool:

```text
Cline CLI
```

Work:

1. Understand Cline CLI capabilities.
2. Implement Cline adapter.
3. Normalize sessions/runs into shared model.
4. Allow tool choice in Slack and web.
5. Compare behavior with Kiro adapter.

---

### Stage 4 — Add second controller

Goal: prove controller architecture.

Options:

- REST API
- Telegram
- Discord
- WhatsApp

Recommended first second controller:

```text
REST API or Telegram
```

Reason:

- REST API proves core decoupling.
- Telegram proves another chat controller without Slack assumptions.

---

### Stage 5 — Search and knowledge layer

Goal: make session history genuinely useful.

Work:

1. SQLite session index.
2. Transcript indexing.
3. Natural-language search.
4. Tags/favorites.
5. Artifacts/files/commands tracking.

---

### Stage 6 — Product polish

Goal: make it feel like a real product.

Work:

1. Setup wizard.
2. Doctor command.
3. Secure defaults.
4. Better dashboard UX.
5. Install/update story.
6. Documentation.
7. Tests.
8. Release packaging.

---

## 6. What “real good product” means here

A real good product should be:

| Quality | Meaning |
|---|---|
| Extensible | Adding Cline or Telegram should not require rewriting the bridge. |
| Safe | Users should not accidentally expose full machine control. |
| Searchable | Old sessions should become useful knowledge, not forgotten logs. |
| Cross-platform | Windows/macOS/Linux should behave predictably. |
| Observable | Failures should be visible and diagnosable. |
| Controller-neutral | Slack, web, Telegram, API should all be peers. |
| Tool-neutral | Kiro, Cline, Claude Code, Codex should all be adapters. |
| Developer-native | Should understand repos, branches, files, commands, tests, sessions. |
| Local-first | Should work locally without cloud infrastructure. |
| Progressive | Starts simple, but architecture supports growth. |

---

## 7. Sharp product thesis

The strongest version of `cli-controller` is not:

> Slack bridge for Kiro.

It is:

> A local-first control plane for AI coding agents, with pluggable tools, pluggable controllers, searchable session memory, and a developer-grade web cockpit.

That is the product direction worth designing toward.
