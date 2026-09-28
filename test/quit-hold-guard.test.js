const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuitHoldGuard, QUIT_HOLD_MS, QUIT_HOLD_REPEAT_GAP_MS } = require('../quit-hold-guard');

const cmdQ = (type = 'keyDown') => ({ type, key: 'q', meta: true, control: false, alt: false, shift: false });

// A guard on a fake clock: `advance(ms)` moves time and fires due timers.
function harness({ enabled = true, running = true } = {}) {
  let clock = 0;
  let timer = null; // the guard keeps at most one watchdog
  const events = [];
  const guard = createQuitHoldGuard({
    isEnabled: () => enabled,
    hasRunningSessions: () => running,
    quit: () => events.push('quit'),
    notify: (state) => events.push(state.phase),
    now: () => clock,
    setTimer: (fn, ms) => (timer = { fn, at: clock + ms }),
    clearTimer: (t) => { if (timer === t) timer = null; },
  });
  const advance = (ms) => {
    clock += ms;
    if (timer && timer.at <= clock) { const { fn } = timer; timer = null; fn(); }
  };
  return { guard, events, advance };
}

test('quits at once when no session is running', () => {
  const { guard, events } = harness({ running: false });
  assert.equal(guard.handleInput(cmdQ()), true);
  assert.deepEqual(events, ['quit']);
});

test('quits at once when the guard is turned off in settings', () => {
  const { guard, events } = harness({ enabled: false });
  guard.handleInput(cmdQ());
  assert.deepEqual(events, ['quit']);
});

test('a single tap starts the hold, then cancels once no repeat arrives', () => {
  const { guard, events, advance } = harness();
  guard.handleInput(cmdQ());
  assert.deepEqual(events, ['start']);
  advance(QUIT_HOLD_REPEAT_GAP_MS);
  assert.deepEqual(events, ['start', 'cancel'], 'released without a keyUp still cancels');
});

test('holding through auto-repeat quits only after the full hold', () => {
  const { guard, events, advance } = harness();
  guard.handleInput(cmdQ());
  for (let t = 100; t < QUIT_HOLD_MS; t += 100) {
    advance(100);
    guard.handleInput(cmdQ());
  }
  assert.ok(!events.includes('quit'), 'not before the hold duration');
  advance(100);
  guard.handleInput(cmdQ());
  assert.deepEqual(events, ['start', 'quit']);
});

test('a repeat gap longer than the watchdog restarts the hold from zero', () => {
  const { guard, events, advance } = harness();
  guard.handleInput(cmdQ());
  advance(QUIT_HOLD_REPEAT_GAP_MS + 1);
  guard.handleInput(cmdQ());
  assert.deepEqual(events, ['start', 'cancel', 'start']);
});

test('releasing Cmd during a hold cancels it', () => {
  const { guard, events } = harness();
  guard.handleInput(cmdQ());
  assert.equal(guard.handleInput({ type: 'keyUp', key: 'Meta', meta: false }), false);
  assert.deepEqual(events, ['start', 'cancel']);
});

test('cancel() (window blur) ends a hold, and is silent when none is active', () => {
  const { guard, events } = harness();
  guard.cancel();
  assert.deepEqual(events, []);
  guard.handleInput(cmdQ());
  guard.cancel();
  assert.deepEqual(events, ['start', 'cancel']);
});

test('leaves other keys alone', () => {
  const { guard, events } = harness();
  assert.equal(guard.handleInput({ type: 'keyDown', key: 'r', meta: true, control: false, alt: false }), false);
  assert.equal(guard.handleInput({ type: 'keyDown', key: 'q', meta: true, control: true, alt: false }), false);
  assert.equal(guard.handleInput({ type: 'keyDown', key: 'q', meta: false, control: false, alt: false }), false);
  assert.deepEqual(events, []);
});
