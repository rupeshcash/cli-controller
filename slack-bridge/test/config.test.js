const test = require('node:test');
const assert = require('node:assert');
const { validate } = require('../src/config');

const errs = (c) => c.filter((x) => x.level === 'error');
const warns = (c) => c.filter((x) => x.level === 'warn');

test('missing tokens → fatal errors', () => {
  const c = validate({});
  const msg = errs(c).map((x) => x.msg).join(' ');
  assert.match(msg, /SLACK_BOT_TOKEN/);
  assert.match(msg, /SLACK_APP_TOKEN/);
});

test('allow-all + trust-all → warns, never fatal (sandbox must still boot)', () => {
  const c = validate({ SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', SLACK_ALLOWED_USER_IDS: '*', KIRO_TRUST_TOOLS: 'ALL' });
  assert.equal(errs(c).length, 0, 'no fatal errors');
  assert.ok(warns(c).some((x) => /ALLOW-ALL \+ TRUST-ALL/.test(x.msg)), 'combined warning present');
});

test('valid minimal config → no errors', () => {
  const c = validate({ SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', SLACK_ALLOWED_USER_IDS: 'U123' });
  assert.equal(errs(c).length, 0);
});

test('missing dir-alias path → warning', () => {
  const c = validate({ SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', SLACK_ALLOWED_USER_IDS: 'U1', KIRO_DIR_ALIASES: 'nope:/definitely/not/here/xyz' });
  assert.ok(warns(c).some((x) => /nope/.test(x.msg)));
});
