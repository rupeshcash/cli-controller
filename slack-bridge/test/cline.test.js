// Tests for the Cline brain adapter — asserted against REAL cline 3.x event/history
// shapes captured from the live CLI (2026-07-14), not fabricated ones.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  parseJsonl, parseErrorStream, cleanPrompt, normalizeHistory,
  findClineEntry, resolveExec, buildArgs, adapter, capabilities,
} = require('../../core/brain/cline');
const brains = require('../../core/brain');
const { parseNew } = require('../src/parse');

// ── Real captured event streams ─────────────────────────────────────────────
// A real successful fresh run (trimmed to the decisive events, verbatim shapes).
const REAL_SUCCESS = [
  '{"ts":"2026-07-14T14:06:43.150Z","type":"hook_event","hookEventName":"agent_start","agentId":"agent_1","taskId":"conv_1784038003138_hwxe198","parentAgentId":null}',
  '{"ts":"2026-07-14T14:06:43.152Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
  '{"ts":"2026-07-14T14:06:47.457Z","type":"agent_event","event":{"type":"content_end","contentType":"text","text":"PONG"}}',
  '{"ts":"2026-07-14T14:06:47.461Z","type":"agent_event","event":{"type":"done","reason":"completed","text":"PONG","iterations":1}}',
  '{"ts":"2026-07-14T14:06:47.509Z","type":"run_result","finishReason":"completed","iterations":1,"durationMs":4315,"text":"PONG","model":{"id":"gpt-5.5","provider":"openai-compatible"}}',
].join('\n');

// A real error event (emitted when a prompt is missing) — note it can arrive on stderr.
const REAL_ERROR_EVENT = '{"ts":"2026-07-14T14:08:25.961Z","type":"error","message":"JSON output mode requires a prompt argument or piped stdin (interactive mode is unsupported)"}';

// A real `cline history --json` entry (trimmed; keeps the fields the adapter reads).
const REAL_HISTORY = [
  {
    sessionId: '1784038002990_jb6xe', source: 'cli', status: 'completed', interactive: false,
    provider: 'openai-compatible', model: 'gpt-5.5',
    cwd: 'C:\\Users\\rupes\\AppData\\Local\\Temp\\cline-e2e-probe',
    workspaceRoot: 'C:\\Users\\rupes\\AppData\\Local\\Temp\\cline-e2e-probe',
    prompt: '<user_input mode="act">reply with exactly the single word PONG and nothing else</user_input>',
    metadata: { title: 'reply with exactly the single word PONG and nothing else' },
    updatedAt: '2026-07-14T14:06:47.461Z',
  },
];

// ── parseJsonl ────────────────────────────────────────────────────────────────
test('parseJsonl: real success stream → ok, text from run_result, taskId from hook_event', () => {
  const r = parseJsonl(REAL_SUCCESS);
  // PREVENTS: mis-reading the real run_result (which has NO taskId and uses "completed").
  assert.equal(r.ok, true);
  assert.equal(r.text, 'PONG');
  assert.equal(r.taskId, 'conv_1784038003138_hwxe198'); // captured from hook_event, not run_result
  assert.equal(r.error, '');
});

test('parseJsonl: run_result.finishReason !== "completed" → not ok, with error', () => {
  // PREVENTS: treating an aborted/failed run as success.
  const jsonl = '{"type":"run_result","finishReason":"aborted","text":""}';
  const r = parseJsonl(jsonl);
  assert.equal(r.ok, false);
  assert.match(r.error, /aborted/);
});

test('parseJsonl: explicit error event → not ok + message', () => {
  // PREVENTS: silently succeeding when cline emits a JSON error event.
  const r = parseJsonl(REAL_ERROR_EVENT);
  assert.equal(r.ok, false);
  assert.match(r.error, /requires a prompt argument/);
});

test('parseJsonl: falls back to `done` event text when run_result.text is empty', () => {
  const jsonl = [
    '{"type":"agent_event","event":{"type":"done","reason":"completed","text":"done via done-event"}}',
    '{"type":"run_result","finishReason":"completed","text":""}',
  ].join('\n');
  const r = parseJsonl(jsonl);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'done via done-event');
});

test('parseJsonl: no run_result at all (crash/partial output) → not ok', () => {
  // PREVENTS: a hung/killed process being reported as success.
  const r = parseJsonl('{"type":"hook_event","hookEventName":"agent_start","taskId":"conv_x"}');
  assert.equal(r.ok, false);
});

test('parseJsonl: ignores non-JSON noise lines without throwing', () => {
  const r = parseJsonl('not json\n{"type":"run_result","finishReason":"completed","text":"ok"}\n   \ngarbage');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'ok');
});

test('parseJsonl: extracts model + usage from run_result for the per-turn footer', () => {
  // PREVENTS: the !usage footer / lastModel silently going blank for Cline turns.
  const withModelOnly = parseJsonl(REAL_SUCCESS);
  assert.equal(withModelOnly.model, 'gpt-5.5');
  assert.equal(withModelOnly.usage, null); // this stream reports no token usage

  const withUsage = parseJsonl('{"type":"run_result","finishReason":"completed","text":"hi","model":"claude","aggregateUsage":{"inputTokens":120,"outputTokens":45,"totalCost":0.0031}}');
  assert.equal(withUsage.model, 'claude');
  assert.deepEqual(withUsage.usage, { input: 120, output: 45, cost: 0.0031 });
});

// ── parseErrorStream ────────────────────────────────────────────────────────
test('parseErrorStream: extracts message from a JSON error event on stderr', () => {
  // PREVENTS: losing the real reason when cline writes the error to stderr (observed on Windows).
  assert.match(parseErrorStream(REAL_ERROR_EVENT), /requires a prompt argument/);
});

test('parseErrorStream: raw non-JSON stderr → first line; empty → empty', () => {
  assert.equal(parseErrorStream('boom: something failed\nstack line'), 'boom: something failed');
  assert.equal(parseErrorStream(''), '');
  assert.equal(parseErrorStream('   \n  '), '');
});

// ── cleanPrompt ───────────────────────────────────────────────────────────────
test('cleanPrompt: strips the <user_input mode> wrapper cline stores', () => {
  assert.equal(cleanPrompt('<user_input mode="act">fix the bug</user_input>'), 'fix the bug');
  assert.equal(cleanPrompt('plain prompt'), 'plain prompt');
  assert.equal(cleanPrompt(null), '');
});

// ── normalizeHistory ──────────────────────────────────────────────────────────
test('normalizeHistory: maps real history entry to {sessionId,title,cwd,updatedAt}', () => {
  const [s] = normalizeHistory(REAL_HISTORY);
  assert.equal(s.sessionId, '1784038002990_jb6xe'); // the id used for --id resume
  assert.equal(s.title, 'reply with exactly the single word PONG and nothing else');
  assert.ok(s.cwd.includes('cline-e2e-probe'));
  assert.equal(s.updatedAt, '2026-07-14T14:06:47.461Z');
});

test('normalizeHistory: title falls back to cleaned prompt when metadata.title absent', () => {
  const [s] = normalizeHistory([{ sessionId: 'x', prompt: '<user_input mode="act">do a thing</user_input>', updatedAt: 't' }]);
  assert.equal(s.title, 'do a thing');
});

test('normalizeHistory: drops entries without a sessionId; tolerates junk', () => {
  assert.equal(normalizeHistory([{ foo: 1 }, { sessionId: 'ok' }]).length, 1);
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory('nonsense'), []);
});

// ── findClineEntry (pure, injected PATH + exists) ──────────────────────────────
test('findClineEntry: returns the JS entry beside the npm shim on PATH', () => {
  // OS-portable: build dirs with path.sep and join PATH with path.delimiter so the
  // test exercises the same logic on Windows, macOS, and Linux (no hardcoded C:\ / ;).
  const shimDir = path.join(path.sep, 'usr', 'lib', 'npm');
  const entry = path.join(shimDir, 'node_modules', 'cline', 'bin', 'cline');
  const present = new Set([path.join(shimDir, 'cline.cmd'), entry]);
  const exists = (p) => present.has(p);
  const PATHENV = [path.join(path.sep, 'bin'), shimDir].join(path.delimiter);
  assert.equal(findClineEntry(PATHENV, exists), entry);
});

test('findClineEntry: returns null when shim present but entry missing, or nothing on PATH', () => {
  const shimDir = path.join(path.sep, 'opt', 'npm');
  const onlyShim = (p) => p === path.join(shimDir, 'cline.cmd');
  assert.equal(findClineEntry(shimDir, onlyShim), null);
  assert.equal(findClineEntry([path.join(path.sep, 'bin'), path.join(path.sep, 'other')].join(path.delimiter), () => false), null);
  assert.equal(findClineEntry('', () => true), null);
});

// ── resolveExec (pure, injected platform/env/exists) ───────────────────────────
test('resolveExec: Windows with entry found → node-direct, no shell', () => {
  // PREVENTS: the EINVAL bug — spawning cline.cmd without a shell.
  // OS-portable dirs (path.sep) so it validates the win32 branch on any host.
  const shimDir = path.join(path.sep, 'usr', 'lib', 'npm');
  const entry = path.join(shimDir, 'node_modules', 'cline', 'bin', 'cline');
  const present = new Set([path.join(shimDir, 'cline.cmd'), entry]);
  const r = resolveExec({ platform: 'win32', env: { PATH: shimDir }, exists: (p) => present.has(p), execPath: 'NODE' });
  assert.deepEqual(r, { cmd: 'NODE', prefix: [entry], shell: false });
});

test('resolveExec: Windows with no entry → shell fallback on the cline shim', () => {
  const r = resolveExec({ platform: 'win32', env: { PATH: path.join(path.sep, 'Windows') }, exists: () => false, execPath: 'NODE' });
  assert.deepEqual(r, { cmd: 'cline', prefix: [], shell: true });
});

test('resolveExec: unix → spawn cline directly (shebang script), no shell', () => {
  const r = resolveExec({ platform: 'darwin', env: { PATH: '/usr/local/bin' }, exists: () => true, execPath: 'NODE' });
  assert.deepEqual(r, { cmd: 'cline', prefix: [], shell: false });
});

test('resolveExec: CLINE_BIN pointing at a .js entry → run it with node', () => {
  const r = resolveExec({ platform: 'win32', env: { CLINE_BIN: '/custom/cline.js' }, exists: (p) => p === '/custom/cline.js', execPath: 'NODE' });
  assert.deepEqual(r, { cmd: 'NODE', prefix: ['/custom/cline.js'], shell: false });
});

test('resolveExec: CLINE_BIN as a command name → shell only on Windows', () => {
  assert.deepEqual(
    resolveExec({ platform: 'win32', env: { CLINE_BIN: 'my-cline' }, exists: () => false, execPath: 'N' }),
    { cmd: 'my-cline', prefix: [], shell: true });
  assert.deepEqual(
    resolveExec({ platform: 'linux', env: { CLINE_BIN: 'my-cline' }, exists: () => false, execPath: 'N' }),
    { cmd: 'my-cline', prefix: [], shell: false });
});

// ── buildArgs ─────────────────────────────────────────────────────────────────
test('buildArgs: safe defaults — json + auto-approve false + cwd', () => {
  const a = buildArgs({ cwd: '/repo', trustTools: 'fs_read' });
  assert.deepEqual(a, ['--json', '--auto-approve', 'false', '-c', '/repo']);
});

test('buildArgs: trust ALL → auto-approve true; sessionId/model/provider/timeout mapped', () => {
  const a = buildArgs({ cwd: '/r', sessionId: 'sid1', model: 'gpt-5.5', provider: 'openai-compatible', trustTools: 'ALL', timeoutMs: 90000 });
  assert.deepEqual(a, ['--json', '--auto-approve', 'true', '-c', '/r', '--id', 'sid1', '-m', 'gpt-5.5', '-P', 'openai-compatible', '-t', '90']);
});

test('buildArgs: plan mode adds -p right after cwd (before resume/model flags)', () => {
  // PREVENTS: !plan being a silent no-op for Cline — the -p flag must actually be passed.
  assert.deepEqual(
    buildArgs({ cwd: '/r', trustTools: 'fs_read', plan: true }),
    ['--json', '--auto-approve', 'false', '-c', '/r', '-p']);
  // act mode (plan falsy) omits -p entirely
  assert.equal(buildArgs({ cwd: '/r', plan: false }).includes('-p'), false);
});

// ── adapter wiring & capabilities ──────────────────────────────────────────────
test('cline: registered in the brain registry', () => {
  assert.ok(brains.listBrains().includes('cline'));
  assert.equal(brains.getBrain('cline').id, 'cline');
});

test('cline capabilities: resume/models yes, streaming + plan yes, no lock, no named agents', () => {
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.models, true);
  assert.equal(capabilities.agents, false);
  assert.equal(capabilities.singleWriterLock, false);
  assert.equal(capabilities.incrementalOutput, true);
  assert.equal(capabilities.planMode, true);
});

test('cline prepareResume never blocks (no single-writer lock)', async () => {
  assert.deepEqual(await adapter.prepareResume('anything'), { action: 'ok' });
});

test('cline buildResumeCommand includes cwd + --id', () => {
  const cmd = adapter.buildResumeCommand({ cwd: '/repo', id: 'sid1' });
  assert.match(cmd, /--id sid1/);
  assert.match(cmd, /\/repo/);
});

// ── runCline lifecycle (injected fake spawn — no real process, no hang) ────────
const { EventEmitter } = require('node:events');
const { runCline } = require('../../core/brain/cline');

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = false;
  c.kill = () => { c.killed = true; queueMicrotask(() => c.emit('close', null)); };
  return c;
}

test('runCline: success path parses output and returns NO sessionId (runner captures it)', async () => {
  // PREVENTS: adapter returning the wrong id (conv_*) that would break resume.
  const child = fakeChild();
  const p = runCline({ cwd: '/r', prompt: 'hi', trustTools: 'fs_read' }, () => child);
  queueMicrotask(() => { child.stdout.emit('data', Buffer.from(REAL_SUCCESS)); child.emit('close', 0); });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.output, 'PONG');
  assert.equal(r.error, '');
  assert.equal(r.sessionId, undefined);
  assert.equal(r.model, 'gpt-5.5'); // model surfaced for the footer
});

test('runCline: spawn failure → ok:false with a clear error, never throws', async () => {
  const r = await runCline({ cwd: '/r', prompt: 'hi' }, () => { throw new Error('ENOENT'); });
  assert.equal(r.ok, false);
  assert.match(r.error, /Failed to start cline/);
});

test('runCline: error event on stderr surfaces as the failure reason', async () => {
  const child = fakeChild();
  const p = runCline({ cwd: '/r', prompt: 'hi' }, () => child);
  queueMicrotask(() => { child.stderr.emit('data', Buffer.from(REAL_ERROR_EVENT)); child.emit('close', 1); });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /requires a prompt argument/);
});

test('runCline: enforced kill-timeout kills a hung child and reports a timeout (no infinite hang)', async () => {
  // PREVENTS: the 19-minute hang — cline blocking on headless tool approval must be bounded.
  const child = fakeChild();
  const p = runCline({ cwd: '/r', prompt: 'do a thing', timeoutMs: 10 }, () => child);
  // never emit close on our own — only the enforced timeout's child.kill() ends it
  const r = await p;
  assert.equal(child.killed, true);
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

// ── bridge command parsing ──────────────────────────────────────────────────
test('parseNew: brain=cline is parsed', () => {
  const { patch, prompt } = parseNew('!new brain=cline dir=api do it', { api: '/p' });
  assert.equal(patch.brain, 'cline');
  assert.equal(patch.cwd, '/p');
  assert.equal(prompt, 'do it');
});
