const test = require('node:test');
const assert = require('node:assert');
const { extractJson, buildPrompt } = require('../src/broker');

// PREVENTS: Windows cwd corruption ("C:\Users\..." -> "C:Usersdev...") that made
// cline/kiro spawn in a nonexistent dir → "spawn cmd.exe ENOENT".
test('extractJson parses a Windows path with single backslashes (invalid JSON escapes)', () => {
  const raw = 'noise {"cwd":"C:\\Users\\dev\\Desktop\\proj","agent":"main","prompt":""} trailing';
  const j = extractJson(raw);
  assert.ok(j, 'should parse via backslash repair, not return null');
  // backslashes preserved as path separators (not eaten as \U, etc.)
  assert.equal(j.cwd, 'C:\\Users\\dev\\Desktop\\proj');
  assert.equal(j.agent, 'main');
});

// PREVENTS: a path segment that is a VALID JSON escape (\report -> \r=CR,
// \node -> \n=LF, \temp -> \t=TAB) silently corrupting the directory even though
// strict JSON.parse "succeeds".
test('extractJson repairs a path whose segment is a valid JSON escape (\\report\\node stays literal)', () => {
  const j = extractJson('{"cwd":"C:\\report\\node_modules"}');
  assert.ok(j);
  assert.equal(j.cwd, 'C:\\report\\node_modules');
  assert.ok(!/[\u0000-\u001f]/.test(j.cwd), 'no control character leaked into the path');
});

test('extractJson still parses well-formed JSON (forward slashes / escaped backslashes) unchanged', () => {
  assert.equal(extractJson('{"cwd":"C:/Users/dev/proj"}').cwd, 'C:/Users/dev/proj');
  assert.equal(extractJson('{"cwd":"C:\\\\Users\\\\dev"}').cwd, 'C:\\Users\\dev');
  assert.equal(extractJson('{"cwd":"/home/u/p"}').cwd, '/home/u/p');
});

test('extractJson preserves legitimate escapes in prose (note with a newline)', () => {
  const j = extractJson('{"cwd":"/tmp","note":"line1\\nline2"}');
  assert.equal(j.note, 'line1\nline2');
});

test('extractJson returns null when there is no JSON object', () => {
  assert.equal(extractJson('sorry, no json here'), null);
  assert.equal(extractJson(''), null);
});

// PREVENTS: the router prompt showing backslash paths that the model echoes back
// (re-introducing the corruption). Paths are presented with forward slashes.
test('buildPrompt presents workspace paths with forward slashes', () => {
  const ctx = {
    aliases: { proj: 'C:\\Users\\dev\\proj' },
    quick: {},
    defaultAgent: 'main', defaultCwd: 'C:\\Users\\dev', brains: ['kiro', 'cline'], defaultBrain: 'kiro',
  };
  const p = buildPrompt('work in proj', ctx);
  assert.ok(p.includes('C:/Users/dev/proj'), 'alias path uses forward slashes');
  assert.ok(!p.includes('C:\\Users\\dev\\proj'), 'no backslash path in the prompt');
  assert.ok(/FORWARD SLASHES/i.test(p), 'prompt instructs forward slashes');
});
