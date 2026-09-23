const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attentionReasonForAgent,
  computeBlockedAgentNotifications,
  parseAgentsJson,
  nativeNotificationForAgent,
} = require('../blocked-agent-notifications');

// Samples copied from real `claude agents --json` output (2026-09-22).
const backgroundBlocked = {
  id: 'b462e8b6',
  cwd: '/tmp/project-a',
  kind: 'background',
  sessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
  name: 'Create telemetry correlation use case examples',
  state: 'blocked',
};
const interactivePermission = {
  pid: 9764,
  cwd: '/tmp/project-b',
  kind: 'interactive',
  sessionId: 'bbbbbbbb-0000-0000-0000-000000000002',
  name: 'gnrx-51',
  status: 'waiting',
  waitingFor: 'permission prompt',
};
const interactiveInput = {
  pid: 55686,
  cwd: '/tmp/project-c',
  kind: 'interactive',
  sessionId: 'cccccccc-0000-0000-0000-000000000003',
  name: 'context-engineering-f0',
  status: 'waiting',
  waitingFor: 'input needed',
};
const interactiveIdle = {
  pid: 92724,
  cwd: '/tmp/project-d',
  kind: 'interactive',
  sessionId: 'dddddddd-0000-0000-0000-000000000004',
  name: 'idle-one',
  status: 'idle',
};
const backgroundWorking = {
  id: 'e1e1e1e1',
  pid: 1234,
  cwd: '/tmp/project-e',
  kind: 'background',
  sessionId: 'eeeeeeee-0000-0000-0000-000000000005',
  name: 'busy-one',
  state: 'working',
  status: 'busy',
};

function compute(agents, hosted = [], previous = new Map()) {
  return computeBlockedAgentNotifications({
    agents,
    hostedSessionIds: hosted,
    previousReasons: previous,
  });
}

test('attention reason recognises both the background `state` and the interactive `status` shapes', () => {
  assert.equal(attentionReasonForAgent(backgroundBlocked), 'blocked');
  assert.equal(attentionReasonForAgent(interactivePermission), 'permission prompt');
  assert.equal(attentionReasonForAgent(interactiveInput), 'input needed');
  assert.equal(attentionReasonForAgent(interactiveIdle), null);
  assert.equal(attentionReasonForAgent(backgroundWorking), null);
  assert.equal(attentionReasonForAgent(null), null);
});

test('a background agent that is blocked while waiting reports the specific reason, not the generic one', () => {
  const blockedOnPermission = { ...backgroundBlocked, status: 'waiting', waitingFor: 'permission prompt' };
  assert.equal(attentionReasonForAgent(blockedOnPermission), 'permission prompt');
});

test('waiting sessions produce one notification each, with the message the renderer classifies', () => {
  const { notifications } = compute([interactivePermission, interactiveInput, interactiveIdle, backgroundBlocked]);

  assert.deepEqual(notifications.map(n => n.sessionId), [
    interactivePermission.sessionId,
    interactiveInput.sessionId,
    backgroundBlocked.sessionId,
  ]);
  // public/app.js marks a session as needing attention on this regex.
  const attentionRe = /attention|approval|permission|needs your|wants to enter/i;
  for (const notification of notifications) {
    assert.match(notification.message, attentionRe);
  }
  assert.equal(notifications[0].message, 'Claude needs your permission to continue');
  assert.match(notifications[1].message, /input needed/);
  assert.equal(notifications[0].cwd, '/tmp/project-b');
  assert.equal(notifications[1].name, 'context-engineering-f0');
});

test('a session that stays blocked is notified once, not on every tick', () => {
  const first = compute([interactivePermission]);
  assert.equal(first.notifications.length, 1);

  const second = compute([interactivePermission], [], first.reasons);
  assert.equal(second.notifications.length, 0);

  const third = compute([interactivePermission], [], second.reasons);
  assert.equal(third.notifications.length, 0);
});

test('leaving the blocked state then re-entering it notifies again', () => {
  const blocked = compute([interactivePermission]);
  const unblocked = compute([{ ...interactivePermission, status: 'busy', waitingFor: undefined }], [], blocked.reasons);
  assert.equal(unblocked.notifications.length, 0);
  assert.equal(unblocked.reasons.size, 0);

  const reblocked = compute([interactivePermission], [], unblocked.reasons);
  assert.equal(reblocked.notifications.length, 1);
});

test('a session that moves from input needed to a permission prompt notifies again', () => {
  const waitingOnInput = { ...interactivePermission, waitingFor: 'input needed' };
  const first = compute([waitingOnInput]);
  assert.equal(first.notifications[0].reason, 'input needed');

  const second = compute([interactivePermission], [], first.reasons);
  assert.equal(second.notifications.length, 1);
  assert.equal(second.notifications[0].reason, 'permission prompt');
});

test('sessions Switchboard hosts are not notified — their PTY already raises OSC 9', () => {
  const hosted = [interactivePermission.sessionId];
  const { notifications, reasons } = compute([interactivePermission, interactiveInput], hosted);

  assert.deepEqual(notifications.map(n => n.sessionId), [interactiveInput.sessionId]);
  // Still remembered, so closing its terminal later doesn't fire a stale notification.
  assert.equal(reasons.get(interactivePermission.sessionId), 'permission prompt');
});

test('a hosted session that stops being hosted while still blocked stays silent', () => {
  const hostedTick = compute([interactivePermission], [interactivePermission.sessionId]);
  assert.equal(hostedTick.notifications.length, 0);

  const afterClose = compute([interactivePermission], [], hostedTick.reasons);
  assert.equal(afterClose.notifications.length, 0);
});

test('entries without a session id are ignored rather than notified under a bogus key', () => {
  const { notifications, reasons } = compute([
    { kind: 'interactive', status: 'waiting', waitingFor: 'input needed' },
    { sessionId: '', status: 'waiting' },
    interactiveInput,
  ]);
  assert.deepEqual(notifications.map(n => n.sessionId), [interactiveInput.sessionId]);
  assert.equal(reasons.size, 1);
});

test('a missing or malformed agent list yields no notifications instead of throwing', () => {
  assert.equal(compute(undefined).notifications.length, 0);
  assert.equal(compute(null).notifications.length, 0);
  assert.equal(compute('not an array').notifications.length, 0);
  assert.equal(compute([null, undefined, 42]).notifications.length, 0);
});

test('agent JSON survives a login shell printing a banner before the array', () => {
  const array = JSON.stringify([interactivePermission]);
  assert.deepEqual(parseAgentsJson(array), [interactivePermission]);
  assert.deepEqual(parseAgentsJson(`shell init noise\n${array}\n`), [interactivePermission]);
  assert.equal(parseAgentsJson(''), null);
  assert.equal(parseAgentsJson('command not found: claude'), null);
  assert.equal(parseAgentsJson('{"error":"nope"}'), null);
});

test('native notification names the reason, the session and its folder', () => {
  assert.deepEqual(nativeNotificationForAgent({
    reason: 'permission prompt', name: 'gnrx-51', cwd: '/Users/me/src/app', homeDir: '/Users/me',
  }), { title: 'Claude needs your permission', body: 'gnrx-51\n~/src/app' });
  assert.deepEqual(nativeNotificationForAgent({
    reason: 'input needed', name: null, cwd: '/Users/me', homeDir: '/Users/me',
  }), { title: 'Claude needs your input', body: '~' });
});

test('native notification keeps paths outside home, and never has an empty body', () => {
  assert.deepEqual(nativeNotificationForAgent({
    reason: 'blocked', name: '', cwd: '/Users/meow/x', homeDir: '/Users/me',
  }), { title: 'Claude session is blocked', body: '/Users/meow/x' });
  assert.equal(nativeNotificationForAgent({ reason: 'blocked' }).body, 'Session outside the sidebar');
});
