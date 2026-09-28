const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function harness() {
  const refreshes = [];
  const context = vm.createContext({
    Date, Number, Math,
    sessionBusyState: new Map(),
    refreshProjectViews: arg => refreshes.push(arg),
  });
  vm.runInContext(app.slice(app.indexOf('const sessionEventTimes = new Map()'), app.indexOf('function saveSessionNotices(')), context);
  vm.runInContext('this.sessionEventTimes = sessionEventTimes; this.sessionHandoffTimes = sessionHandoffTimes;', context);
  return { state: context, refreshes };
}

test('a spawner sorts below its successor until someone types into it', () => {
  const { state, refreshes } = harness();
  const spawner = { sessionId: 'spawner', modified: new Date(1000).toISOString() };
  const successor = { sessionId: 'successor', modified: null };

  state.recordSessionHandoff('spawner');
  const handoff = state.sessionHandoffTimes.get('spawner');
  state.sessionEventTimes.set('successor', handoff + 1);
  // The spawner's turn ends and its transcript is written after the handoff.
  state.sessionEventTimes.set('spawner', handoff + 5000);
  spawner.modified = new Date(handoff + 6000).toISOString();

  assert.equal(state.sessionEventTime(spawner), handoff);
  assert.ok(state.sessionEventTime(successor) > state.sessionEventTime(spawner), 'the successor is the track’s latest');

  state.clearSessionHandoff('spawner');
  assert.equal(state.sessionEventTime(spawner), handoff + 6000, 'typing into the spawner makes it current again');
  assert.equal(refreshes.length, 1);
  state.clearSessionHandoff('spawner');
  assert.equal(refreshes.length, 1, 'a session without a handoff causes no refresh');
});

test('a busy spawner keeps the time its turn began, still capped at the handoff', () => {
  const { state } = harness();
  const spawner = { sessionId: 'spawner', modified: null };
  state.recordSessionHandoff('spawner');
  const handoff = state.sessionHandoffTimes.get('spawner');
  state.sessionBusyState.set('spawner', true);
  state.sessionEventTimes.set('spawner', handoff - 3000);
  assert.equal(state.sessionEventTime(spawner), handoff - 3000);
  state.sessionEventTimes.set('spawner', handoff + 3000);
  assert.equal(state.sessionEventTime(spawner), handoff);
  state.recordSessionHandoff(null);
  assert.equal(state.sessionHandoffTimes.size, 1, 'a launch without a live spawner records nothing');
});
