const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSessionStates, sessionStatesFilePath, writeSessionStatesFile, removeSessionStatesFile,
} = require('../session-states');

function recordingStore() {
  const published = [];
  const store = createSessionStates({ onChange: sessions => published.push(sessions) });
  return { store, published };
}

test('only sessions with something to report are listed, with both flags merged per session', () => {
  const { store } = recordingStore();
  store.setWaiting(new Map([['b', 'input needed'], ['a', 'awaiting reply']]));
  store.setScrolledUp('b', true);
  store.setScrolledUp('c', true);
  assert.deepEqual(store.snapshot(), {
    a: { waitingFor: 'awaiting reply' },
    b: { waitingFor: 'input needed', scrolledUp: true },
    c: { scrolledUp: true },
  });
});

test('each poll replaces the waiting set: a session missing from it stopped waiting', () => {
  const { store } = recordingStore();
  store.setWaiting(new Map([['a', 'input needed'], ['b', 'input needed']]));
  store.setWaiting(new Map([['b', 'input needed']]));
  assert.deepEqual(store.snapshot(), { b: { waitingFor: 'input needed' } });
});

test('a poll that changes nothing publishes nothing', () => {
  const { store, published } = recordingStore();
  store.setWaiting(new Map([['a', 'input needed']]));
  store.setWaiting(new Map([['a', 'input needed']]));
  store.setScrolledUp('z', false);
  assert.equal(published.length, 1);
});

test('a changed reason is published even when the set of sessions is the same', () => {
  const { store, published } = recordingStore();
  store.setWaiting(new Map([['a', 'input needed']]));
  store.setWaiting(new Map([['a', 'Claude needs your permission']]));
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], { a: { waitingFor: 'Claude needs your permission' } });
});

test('a session that turns busy loses its waiting badge before the next poll, scroll state kept', () => {
  const { store, published } = recordingStore();
  store.setWaiting(new Map([['a', 'input needed']]));
  store.setScrolledUp('a', true);
  store.clearWaiting(['a', null, 'unknown']);
  assert.deepEqual(store.snapshot(), { a: { scrolledUp: true } });
  assert.equal(published.length, 3);
  store.clearWaiting(['a']);
  assert.equal(published.length, 3, 'clearing an already-clear session publishes nothing');
});

test('scrolling back to the bottom removes the session; a bad id is ignored', () => {
  const { store } = recordingStore();
  store.setScrolledUp('a', true);
  store.setScrolledUp('a', false);
  store.setScrolledUp('', true);
  store.setScrolledUp(undefined, true);
  assert.deepEqual(store.snapshot(), {});
});

test('a renderer reload drops scroll state but keeps waiting state, and gets it republished', () => {
  const { store, published } = recordingStore();
  store.setWaiting(new Map([['a', 'input needed']]));
  store.setScrolledUp('b', true);
  store.resetScrolledUp();
  assert.deepEqual(store.snapshot(), { a: { waitingFor: 'input needed' } });
  const before = published.length;
  store.forgetPublished();
  store.setWaiting(new Map([['a', 'input needed']]));
  assert.equal(published.length, before + 1, 'unchanged state is sent again to a fresh renderer');
});

test('the state file is written whole, readable as JSON, and removed on quit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-session-states-'));
  const file = sessionStatesFilePath(dir);
  assert.equal(path.basename(file), 'session-states.json');
  writeSessionStatesFile(file, { a: { waitingFor: 'input needed' } }, new Date('2026-10-06T12:00:00Z'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    updatedAt: '2026-10-06T12:00:00.000Z',
    sessions: { a: { waitingFor: 'input needed' } },
  });
  assert.deepEqual(fs.readdirSync(dir), ['session-states.json'], 'no temporary file left behind');
  removeSessionStatesFile(file);
  removeSessionStatesFile(file);
  assert.equal(fs.existsSync(file), false);
});
