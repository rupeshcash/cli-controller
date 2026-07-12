const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { parseNew, expandHome, resolveDir } = require('../src/parse');

test('parseNew: key=value options + prompt', () => {
  const { patch, prompt } = parseNew('!new agent=main model=opus fix the bug', {});
  assert.equal(patch.agent, 'main');
  assert.equal(patch.model, 'opus');
  assert.equal(prompt, 'fix the bug');
});

test('parseNew: dir alias resolves to path', () => {
  const { patch, prompt } = parseNew('!new api add tests', { api: '~/work/api' });
  assert.equal(patch.cwd, expandHome('~/work/api'));
  assert.equal(prompt, 'add tests');
});

test('parseNew: -q sets verbose false, -v sets true', () => {
  assert.equal(parseNew('!new -q do it', {}).patch.verbose, false);
  assert.equal(parseNew('!new -v do it', {}).patch.verbose, true);
});

test('parseNew: bare absolute path as cwd', () => {
  const { patch, prompt } = parseNew('!new /tmp/x run', {});
  assert.equal(patch.cwd, '/tmp/x');
  assert.equal(prompt, 'run');
});

test('parseNew: no opts → whole thing is the prompt', () => {
  assert.equal(parseNew('!new just do this', {}).prompt, 'just do this');
});

test('expandHome + resolveDir', () => {
  assert.equal(expandHome('~/x'), os.homedir() + '/x');
  assert.equal(expandHome('/abs'), '/abs');
  assert.equal(resolveDir({ a: '/p' }, 'a'), '/p');
  assert.equal(resolveDir({}, '/direct'), '/direct');
});
