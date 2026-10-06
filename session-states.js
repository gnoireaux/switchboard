// Live per-session state that matters when deciding what to look at next:
// which sessions are waiting on the user, and which terminals the user has
// scrolled up in (mid-reading). Neither is in the transcript, so a session
// triaging other sessions cannot see them without asking Switchboard.
//
// Main owns one store. Waiting reasons come from the `claude agents` poller and
// cover every agent, hosted or not; scroll positions come from the renderer,
// which only knows the terminals it has open. Each change is published to the
// renderer (row badges), a JSON file in the data dir and the launch socket.

const fs = require('fs');
const path = require('path');

const SESSION_STATES_FILE = 'session-states.json';

// onChange(sessions) runs only when the published content differs from the last
// call, so a poll that finds nothing new costs no IPC or disk write.
function createSessionStates({ onChange = null } = {}) {
  let waiting = new Map();
  const scrolledUp = new Set();
  let lastPublished = null;

  // Only sessions with something to report are listed: a reader asks "which
  // sessions need me", and every other session would be noise.
  function snapshot() {
    const ids = [...new Set([...waiting.keys(), ...scrolledUp])].sort();
    const sessions = {};
    for (const id of ids) {
      const state = {};
      if (waiting.has(id)) state.waitingFor = waiting.get(id);
      if (scrolledUp.has(id)) state.scrolledUp = true;
      sessions[id] = state;
    }
    return sessions;
  }

  function publishIfChanged() {
    const sessions = snapshot();
    const serialized = JSON.stringify(sessions);
    if (serialized === lastPublished) return;
    lastPublished = serialized;
    if (onChange) onChange(sessions);
  }

  return {
    snapshot,
    // Replaces the waiting set wholesale: the poller sees every agent each tick,
    // so a session missing from `reasons` has stopped waiting.
    setWaiting(reasons) {
      waiting = new Map(reasons instanceof Map ? reasons : Object.entries(reasons || {}));
      publishIfChanged();
    },
    // A session that turns busy was answered; it should not keep its badge
    // until the next poll.
    clearWaiting(ids) {
      let removed = false;
      for (const id of ids) if (id && waiting.delete(id)) removed = true;
      if (removed) publishIfChanged();
    },
    setScrolledUp(id, isScrolledUp) {
      if (typeof id !== 'string' || !id) return;
      if (isScrolledUp) scrolledUp.add(id);
      else scrolledUp.delete(id);
      publishIfChanged();
    },
    // A reloaded renderer has no terminals yet; it reports again as it opens them.
    resetScrolledUp() {
      scrolledUp.clear();
      publishIfChanged();
    },
    // Forces the next change check to publish, for a renderer that has just
    // loaded and has not seen the current state.
    forgetPublished() {
      lastPublished = null;
    },
  };
}

function sessionStatesFilePath(dataDir) {
  return path.join(dataDir, SESSION_STATES_FILE);
}

// Written to a temporary file and renamed, so a reader never sees half a file.
function writeSessionStatesFile(filePath, sessions, now = new Date()) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify({ updatedAt: now.toISOString(), sessions }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, filePath);
}

// A file left behind by a quit app would describe sessions nobody is tracking.
function removeSessionStatesFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

module.exports = {
  SESSION_STATES_FILE,
  createSessionStates,
  sessionStatesFilePath,
  writeSessionStatesFile,
  removeSessionStatesFile,
};
