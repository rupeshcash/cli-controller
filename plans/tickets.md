# Tickets / TODOs

Running log of deferred work and follow-ups. One entry per ticket.

---

## CLI-TELE-1 — Cline: guard concurrent terminal + Slack use of a resumed session 🔜 (TODO)

**Status:** Deferred (Cline not actively developed).

**Context.** The bridge now surfaces a copyable *terminal-resume* command when a session starts
and in `!status` (brain-agnostic, via `adapter.buildResumeCommand` — `slack-bridge/src/index.js`).
This lets a user pull a bridge-created session back into their terminal.

**The gap (Cline-only).** Cline has **no single-writer lock** (`capabilities.singleWriterLock = false`
in `core/brain/cline.js`; its `prepareResume` always returns `{ action: 'ok' }`). So if a user resumes
a Cline session in the terminal AND keeps replying to the same session in the Slack thread, **both
processes write to the same session concurrently with no protection and no warning** — interleaved /
conflicting history.

Kiro is safe here: it holds a `.lock` during a turn, `prepareResume` detects a live PID, and the bridge
refuses (offers `!teleport <id> force`). None of that exists for Cline.

**TODO when Cline is revisited:**
- [ ] Confirm whether the `cline` CLI writes a lock / has any concurrency guard on `--id` resume.
- [ ] If not, add a soft guard: on Cline resume, warn that the session may be open elsewhere and that
      concurrent terminal + Slack use can corrupt history (no hard lock to rely on).
- [ ] Consider a lightweight bridge-side advisory lock (last-writer pid/ts in memory store) so at least
      the bridge can warn when it recently ran a turn that the terminal might now be racing.
- [ ] Decide whether `!teleport … force` should mean anything for a lock-less brain (currently a no-op).
- [ ] Do NOT special-case Kiro in the shared teleport/resume path — keep the guard behind a brain
      capability flag (e.g. reuse/extend `singleWriterLock`) so it stays generic.

**Do not overfit to Kiro** while implementing the resume-command feature — the terminal-resume surfacing
is already brain-agnostic; this ticket only tracks the Cline-specific safety gap.

---

## CLI-IMG-1 — Slack image + text-snippet forwarding to Kiro ✅ (shipped)

**Status:** Done (2026-07-14, branch `feat/cline-support-main`).

A Slack user can attach an **image** or a **text snippet** in a DM/thread; the bridge downloads it
and forwards it to the brain (and, as text, to the manager/router).

- Image input is **gated on the brain's `images` capability** (`core/brain/*.js`): Kiro `true`, Cline `false`.
- Mechanism: neither CLI takes an image argument, so the file is downloaded to a temp dir and its
  **path is referenced in the prompt**; Kiro's `fs_read` Image mode reads it (verified headless
  2026-07-14 — kiro-cli read a PNG and correctly named its color, using the default `--trust-tools=fs_read`).
- Files: `slack-bridge/src/attachments.js` (new), `slack-bridge/src/index.js` (wiring), capability flags in
  `core/brain/kiro.js` and `core/brain/cline.js`.

**Setup required:** the Slack bot needs the **`files:read`** OAuth scope to download `url_private_download`.
Socket Mode already delivers `file_share` events under the existing `message` subscription. Without the
scope, downloads fail with HTTP 401/403 and the user sees a `⚠️ download failed …` notice.

---

## CLI-IMG-2 — Cline image support (revisit) 🔜 (TODO)

**Status:** Deferred. Cline currently forwards **text snippets only**; images are skipped with a notice.

**Why deferred:** the `cline` CLI (v3.0.39) exposes **no image-input flag** (`cline --help` has only a
text prompt positional + `-s/--system`), and its file-read tool is text-oriented — there is no verified
path to make it *see* pixels headlessly. `capabilities.images = false` in `core/brain/cline.js`.

**TODO when revisiting:**
- [ ] Re-check the Cline CLI for an image/attachment input (flag, stdin protocol, or ACP-mode image message).
- [ ] Confirm the selected provider/model is vision-capable and that Cline actually attaches the image to the LLM turn (not just reads bytes as text).
- [ ] Confirm headless auto-approve doesn't hang on the image read (`--auto-approve true`).
- [ ] Add a small headless proof (like the Kiro PNG test) before flipping the flag.
- [ ] Flip `capabilities.images` to `true` in `core/brain/cline.js` and remove the `TODO(cline-images)` comment.
- [ ] Decide how Cline references the image (inline base64 vs path) and, if needed, extend the adapter's
      `runTurn` to format attachments per-brain instead of the bridge baking a path into the prompt string.
- [ ] Update `plans/tickets.md` (this entry) and the bridge help text.

**Also worth doing (nice-to-have, brain-agnostic):**
- [ ] Carry attachments as **structured data** through `runTurn({ attachments })` rather than pre-baking
      the path into the prompt string, so each brain formats image references its own way.
- [ ] Wire attachment temp-file cleanup to `!end` (today: 24h startup sweep in `attachments.sweepOld`).
