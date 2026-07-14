# Tickets / TODOs

Running log of deferred work and follow-ups. One entry per ticket.

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
