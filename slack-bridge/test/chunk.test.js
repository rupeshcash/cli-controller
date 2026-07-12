const test = require('node:test');
const assert = require('node:assert');
const { chunk } = require('../src/chunk');

test('chunk: short text → single part', () => {
  const r = chunk('hello world');
  assert.equal(r.length, 1);
  assert.match(r[0], /hello world/);
});

test('chunk: empty → placeholder', () => {
  assert.deepEqual(chunk(''), ['(no output)']);
  assert.deepEqual(chunk('   '), ['(no output)']);
});

test('chunk: long text → multiple numbered parts', () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const r = chunk(long, 200);
  assert.ok(r.length > 1, 'should split');
  assert.match(r[0], /^\*\(1\/\d+\)\*/, 'first part is numbered');
});

test('chunk: a single over-long line is hard-split', () => {
  const r = chunk('x'.repeat(500), 100);
  assert.ok(r.length >= 5);
});
