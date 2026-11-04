// Cmd+Q hold-to-quit guard. The menu's Quit item has no accelerator, so Cmd+Q
// arrives as a key event instead of an immediate quit. With running sessions,
// the user must HOLD Cmd+Q for holdMs.
//
// macOS does NOT deliver keyUp for a key released while Cmd is still held, so
// release can't be detected from keyUp. Instead this relies on auto-repeat:
// while held, the OS streams repeat keyDown events; each one re-arms a watchdog.
// When the key is released the repeats stop, the watchdog fires and cancels.
// Quitting requires a repeat keyDown to arrive after the full hold has elapsed,
// so a single tap (no repeats) can never reach the threshold — fail-safe against
// an accidental Cmd+Q.
//
// The overlay is hidden before quit() is called, not left for the window to
// close: quit() can be refused (the quit guard's "Keep Switchboard Open"), and
// an overlay still showing then dims the window with nothing left to hide it.
function createQuitHoldGuard({
  holdMs, repeatGapMs, hasRunningSessions, quit, showOverlay,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let watchdog = null; // fires when auto-repeat stops (= key released)
  let active = false;
  let startedAt = 0;

  function cancel() {
    if (watchdog) { clearTimer(watchdog); watchdog = null; }
    if (active) {
      active = false;
      showOverlay({ phase: 'cancel' });
    }
  }

  function keyDown() {
    if (!hasRunningSessions()) { quit(); return; }
    if (!active) {
      active = true;
      startedAt = now();
      showOverlay({ phase: 'start', duration: holdMs });
    } else if (now() - startedAt >= holdMs) {
      // Auto-repeat has continued for the full hold duration -> quit for real.
      cancel();
      quit();
      return;
    }
    // Re-arm the release watchdog on every (repeat) keyDown.
    if (watchdog) clearTimer(watchdog);
    watchdog = setTimer(cancel, repeatGapMs);
  }

  return { keyDown, cancel };
}

module.exports = { createQuitHoldGuard };
