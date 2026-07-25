// test/resume-command.test.js — locks the brain-agnostic "resume in terminal" contract.
// The Slack bridge surfaces a copyable terminal-resume command (on session start and via
// !status) by calling brain.buildResumeCommand(). These tests guard that contract so the
// feature keeps working across brains and never regresses (e.g. dropping --agent for Kiro,
// which silently resumes with the wrong agent — see the cli-controller skill).
const test = require('node:test');
const assert = require('node:assert');

const kiro = require('../core/brain/kiro').adapter;
const cline = require('../core/brain/cline').adapter;

test('every brain adapter exposes buildResumeCommand', () => {
  for (const b of [kiro, cline]) {
    assert.equal(typeof b.buildResumeCommand, 'function', `${b.id} must expose buildResumeCommand`);
  }
});

test('kiro resume command includes cwd, --agent, and --resume-id (agent must not be dropped)', () => {
  const cmd = kiro.buildResumeCommand({ id: 'sess-123', cwd: '/tmp/work', agent: 'main' });
  assert.match(cmd, /cd \/tmp\/work/);
  assert.match(cmd, /--agent main/);          // PREVENTS: silent resume with wrong/default agent
  assert.match(cmd, /--resume-id sess-123/);  // PREVENTS: resume attaching to the wrong/new session
});

test('kiro resume command omits --agent cleanly when no agent set', () => {
  const cmd = kiro.buildResumeCommand({ id: 'sess-123', cwd: '/tmp/work', agent: null });
  assert.doesNotMatch(cmd, /--agent/);
  assert.match(cmd, /--resume-id sess-123/);
});

test('cline resume command carries the session id and cwd', () => {
  const cmd = cline.buildResumeCommand({ id: 'task-abc', cwd: '/tmp/proj' });
  assert.match(cmd, /--id task-abc/);         // PREVENTS: resuming the wrong Cline task
  assert.match(cmd, /\/tmp\/proj/);
});

test('cline resume command accepts sessionId as an alias for id', () => {
  const cmd = cline.buildResumeCommand({ sessionId: 'task-xyz', cwd: '/tmp/proj' });
  assert.match(cmd, /--id task-xyz/);
});
