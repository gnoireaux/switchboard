const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuitHoldGuard } = require('../quit-hold-guard');

function guardHarness({ running = true, quitRefused = false } = {}) {
  let clock = 0;
  let pending = null; // the one live watchdog: { fn }
  const events = [];
  const guard = createQuitHoldGuard({
    holdMs: 2000,
    repeatGapMs: 1200,
    hasRunningSessions: () => running,
    // A refused quit (the quit guard's "Keep Switchboard Open") returns and the window stays.
    quit: () => events.push(quitRefused ? 'quit refused' : 'quit'),
    showOverlay: state => events.push(`overlay ${state.phase}`),
    now: () => clock,
    setTimer: fn => (pending = { fn }),
    clearTimer: handle => { if (pending === handle) pending = null; },
  });
  return {
    guard, events,
    advance: ms => { clock += ms; },
    releaseKey: () => { const w = pending; pending = null; w?.fn(); }, // repeats stop → watchdog fires
    overlayShown: () => events.filter(e => e.startsWith('overlay')).at(-1) === 'overlay start',
  };
}

function holdFor(h, ms, repeatEveryMs = 100) {
  h.guard.keyDown();
  for (let t = repeatEveryMs; t <= ms; t += repeatEveryMs) { h.advance(repeatEveryMs); h.guard.keyDown(); }
}

test('a full hold hides the overlay before quitting, so a refused quit leaves the window usable', () => {
  const h = guardHarness({ quitRefused: true });
  holdFor(h, 2000);
  assert.deepEqual(h.events, ['overlay start', 'overlay cancel', 'quit refused']);
  assert.equal(h.overlayShown(), false);
  h.releaseKey();
  assert.deepEqual(h.events, ['overlay start', 'overlay cancel', 'quit refused'], 'no stale watchdog fires afterwards');
});

test('holding on after a refused quit starts a fresh hold rather than quitting at once', () => {
  const h = guardHarness({ quitRefused: true });
  holdFor(h, 2000);
  h.advance(100);
  h.guard.keyDown();
  assert.equal(h.events.at(-1), 'overlay start');
  assert.equal(h.events.filter(e => e.startsWith('quit')).length, 1);
});

test('a tap or a short hold never quits, and its overlay goes away on release', () => {
  const tap = guardHarness();
  tap.guard.keyDown();
  tap.releaseKey();
  assert.deepEqual(tap.events, ['overlay start', 'overlay cancel']);

  const short = guardHarness();
  holdFor(short, 1900);
  short.guard.cancel(); // keyUp of Cmd, or the window losing focus
  assert.deepEqual(short.events, ['overlay start', 'overlay cancel']);
});

test('with no running session Cmd+Q quits at once, without the overlay', () => {
  const h = guardHarness({ running: false });
  h.guard.keyDown();
  assert.deepEqual(h.events, ['quit']);
});
