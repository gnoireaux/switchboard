// Cmd+Q hold-to-quit guard (macOS). The app menu's Quit item carries no
// accelerator, so Cmd+Q reaches the window's before-input-event and lands here
// instead of quitting outright. With running sessions the user must HOLD Cmd+Q
// for holdMs; with none, or with the guard disabled, it quits immediately.
//
// macOS does NOT deliver keyUp for a key released while Cmd is still held, so
// release can't be detected from keyUp. Instead we rely on auto-repeat: while
// held, the OS streams repeat keyDown events and each one re-arms a watchdog.
// When the key is released the repeats stop, the watchdog fires and cancels.
// Quitting requires a repeat keyDown to arrive after the full hold has elapsed,
// so a single tap (no repeats) can never reach the threshold.

const QUIT_HOLD_MS = 2000;
// Longest gap between auto-repeat keyDowns still treated as "key held". Must
// exceed the system "Delay Until Repeat" (default ~250-500ms) so a genuine hold
// isn't mistaken for a release before the first repeat arrives.
const QUIT_HOLD_REPEAT_GAP_MS = 1200;

function isCmdQ(input) {
  return input.meta && input.key.toLowerCase() === 'q' && !input.control && !input.alt;
}

function createQuitHoldGuard({
  isEnabled,
  hasRunningSessions,
  quit,
  notify,
  holdMs = QUIT_HOLD_MS,
  repeatGapMs = QUIT_HOLD_REPEAT_GAP_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let watchdog = null; // fires when auto-repeat stops (= released)
  let active = false;
  let startedAt = 0;

  const cancel = () => {
    if (watchdog) { clearTimer(watchdog); watchdog = null; }
    if (active) {
      active = false;
      notify({ phase: 'cancel' });
    }
  };

  // Returns true when the input was Cmd+Q and must not reach the page.
  const handleInput = (input) => {
    if (isCmdQ(input)) {
      if (input.type !== 'keyDown') return true;
      if (!isEnabled() || !hasRunningSessions()) { quit(); return true; }
      if (!active) {
        active = true;
        startedAt = now();
        notify({ phase: 'start', duration: holdMs });
      } else if (now() - startedAt >= holdMs) {
        // Auto-repeat has continued for the full hold duration -> quit for real.
        if (watchdog) { clearTimer(watchdog); watchdog = null; }
        active = false;
        quit();
        return true;
      }
      if (watchdog) clearTimer(watchdog);
      watchdog = setTimer(cancel, repeatGapMs);
      return true;
    }
    // Releasing Cmd or Q during a hold cancels it.
    if (input.type === 'keyUp' && ['q', 'meta'].includes(input.key.toLowerCase())) cancel();
    return false;
  };

  return { handleInput, cancel };
}

module.exports = { createQuitHoldGuard, QUIT_HOLD_MS, QUIT_HOLD_REPEAT_GAP_MS };
