// Tests for src/outfile.js — the `!file` command's safety guards + transport-agnostic orchestration.
// Each test states what regression it PREVENTS. The orchestration tests inject a fake uploader so
// they exercise the real control flow with zero Slack dependency.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { isBlockedSecret, resolvePath, readForUpload, deliverWorkspaceFile, errText } = require('../src/outfile');

// ── Secret guard ─────────────────────────────────────────────────────────────
test('isBlockedSecret: blocks credential carriers, allows ordinary source', () => {
  // PREVENTS: a careless `!file .env` (or key/credential) leaking secrets into Slack.
  for (const p of ['.env', '.env.production', 'config/tls.pem', 'deploy.key', 'store.jks',
                    'id_ed25519', 'aws_credentials', '.npmrc', 'infra/.ssh/config', '.aws/credentials']) {
    assert.equal(isBlockedSecret(p), true, `${p} should be blocked`);
  }
  for (const p of ['src/foo.py', 'README.md', 'pkg/keyboard.ts', 'docs/environment.md']) {
    assert.equal(isBlockedSecret(p), false, `${p} should be allowed`);
  }
});

// ── Path confinement ─────────────────────────────────────────────────────────
test('resolvePath: allows paths inside cwd, including normalized ./ and nested ..', () => {
  const cwd = path.join(path.sep, 'home', 'u', 'proj');
  assert.equal(resolvePath(cwd, 'src/a.js').abs, path.join(cwd, 'src', 'a.js'));
  assert.equal(resolvePath(cwd, './src/../a.js').abs, path.join(cwd, 'a.js')); // stays inside → allowed
  assert.equal(resolvePath(cwd, path.join(cwd, 'x')).abs, path.join(cwd, 'x')); // absolute but inside → allowed
});

test('resolvePath: rejects traversal, external absolutes, and the prefix-sibling escape', () => {
  // PREVENTS: reading files outside the session workspace. The sibling case is the classic
  // startsWith(base) bug — `/home/u/proj-evil` shares the `/home/u/proj` prefix but is NOT inside it.
  const cwd = path.join(path.sep, 'home', 'u', 'proj');
  assert.ok(resolvePath(cwd, '../secrets.txt').error, 'parent traversal must be blocked');
  assert.ok(resolvePath(cwd, path.join(path.sep, 'etc', 'passwd')).error, 'external absolute must be blocked');
  assert.ok(resolvePath(cwd, '../proj-evil/x').error, 'prefix-sibling escape must be blocked');
  assert.ok(resolvePath(cwd, '').error, 'empty path must be rejected');
});

// ── Read pipeline ──────────────────────────────────────────────────────────────
test('readForUpload: reads a real file with basename + byte count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi there');
  const r = readForUpload(dir, 'hello.txt');
  assert.equal(r.name, 'hello.txt');
  assert.equal(r.buf.toString(), 'hi there');
  assert.equal(r.size, 8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readForUpload: secret guard runs before stat (blocked file need not exist)', () => {
  // PREVENTS: the guard order regressing so a missing secret reports "not found" and tempts a retry.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
  const r = readForUpload(dir, '.env'); // does not exist on disk
  assert.match(r.error, /secret/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readForUpload: rejects missing file, directory, and oversize', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
  assert.match(readForUpload(dir, 'nope.txt').error, /not found/);
  assert.match(readForUpload(dir, '.').error, /directory/);
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(100));
  assert.match(readForUpload(dir, 'big.txt', 10).error, /limit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Orchestration (injected uploader — no Slack) ───────────────────────────────
test('deliverWorkspaceFile: uploads the exact bytes on success', async () => {
  // PREVENTS: the command claiming success without actually sending, or sending wrong content.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
  fs.writeFileSync(path.join(dir, 'a.py'), 'print(1)');
  const calls = [];
  const res = await deliverWorkspaceFile({ cwd: dir, relPath: 'a.py', upload: (a) => calls.push(a) });
  assert.deepEqual(res, { ok: true, name: 'a.py', size: 8 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, 'a.py');
  assert.equal(calls[0].buf.toString(), 'print(1)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliverWorkspaceFile: never invokes the uploader when a guard fails', async () => {
  // PREVENTS: a secret/out-of-cwd path reaching the transport at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
  let called = false;
  const upload = () => { called = true; };
  const secret = await deliverWorkspaceFile({ cwd: dir, relPath: '.env', upload });
  const escape = await deliverWorkspaceFile({ cwd: dir, relPath: '../x', upload });
  assert.equal(secret.ok, false);
  assert.equal(escape.ok, false);
  assert.equal(called, false, 'uploader must not run on guard failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliverWorkspaceFile: surfaces an uploader failure as a clean error, never throws', async () => {
  // PREVENTS: a Slack upload error crashing the bridge instead of replying to the user.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  const boom = () => { const e = new Error('nope'); e.data = { error: 'file_uploads_disabled' }; throw e; };
  const res = await deliverWorkspaceFile({ cwd: dir, relPath: 'a.txt', upload: boom });
  assert.equal(res.ok, false);
  assert.match(res.error, /upload failed.*file_uploads_disabled/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('errText: prefers Slack Web API error, falls back to message', () => {
  assert.equal(errText({ data: { error: 'not_in_channel' } }), 'not_in_channel');
  assert.equal(errText(new Error('boom')), 'boom');
  assert.equal(errText(null), 'unknown error');
});

// ── Natural-language file discovery (findWorkspaceFiles / parseFetchQuery) ─────
const { findWorkspaceFiles, parseFetchQuery } = require('../src/outfile');

test('parseFetchQuery: pulls the filename token and drops filler words', () => {
  const r = parseFetchQuery('can you fetch me the design.md for ticket ENG-42 please');
  assert.equal(r.name, 'design.md');
  assert.ok(r.qualifiers.includes('eng-42'));
  assert.ok(!r.qualifiers.includes('fetch') && !r.qualifiers.includes('the'));
});

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-'));
  fs.mkdirSync(path.join(dir, 'plans', 'eng-42'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plans', 'eng-99'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plans', 'eng-42', 'design.md'), '# 42');
  fs.writeFileSync(path.join(dir, 'plans', 'eng-99', 'design.md'), '# 99');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'design.md'), 'noise'); // must be ignored
  return dir;
}

test('findWorkspaceFiles: ranks the ticket-qualified match first, ignores node_modules', () => {
  const dir = makeTree();
  const hits = findWorkspaceFiles(dir, 'design.md for eng-42');
  assert.equal(hits[0], path.join('plans', 'eng-42', 'design.md')); // qualifier boosts the eng-42 copy
  assert.ok(hits.includes(path.join('plans', 'eng-99', 'design.md')));
  assert.ok(!hits.some((h) => h.includes('node_modules')), 'node_modules must be skipped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findWorkspaceFiles: matches by qualifier when no filename given', () => {
  const dir = makeTree();
  assert.ok(findWorkspaceFiles(dir, 'readme').includes('README.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findWorkspaceFiles: never surfaces secret files, and empty query → no results', () => {
  // PREVENTS: a fuzzy fetch leaking .env into Slack, or a bare request scanning everything.
  const dir = makeTree();
  assert.deepEqual(findWorkspaceFiles(dir, '.env'), []);
  assert.deepEqual(findWorkspaceFiles(dir, ''), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
