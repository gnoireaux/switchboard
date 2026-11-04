// Which CLI sessions come back after Switchboard restarts.
// Quitting kills every PTY. Main records the Claude/codex sessions still running
// at that moment; the next launch reopens them through the same path a row
// click uses (`claude --resume <id>`), so they keep their session ids.
// Shared by main (recording) and the renderer (reopening).
(function (root) {
  const SETTING_KEY = 'sessionsToResume';

  /** On unless the user turned it off in the global settings. */
  function resumeEnabled(globalSettings) {
    return globalSettings?.resumeSessionsAfterRestart !== false;
  }

  /**
   * The sessions worth bringing back, from main's map of live sessions.
   * Skipped: plain terminals (the renderer restores those itself), sessions
   * whose process already ended, and launches whose real id is still unknown
   * (a codex session that never wrote a transcript has nothing to resume).
   */
  function collectSessionsToResume(activeSessions, waitingReasons = null) {
    const out = [];
    for (const [sessionId, session] of activeSessions || []) {
      if (!session || session.isPlainTerminal || session.exited || session.pendingLaunch) continue;
      if (!session.projectPath) continue;
      const entry = {
        sessionId,
        projectPath: session.projectPath,
        runtime: session.runtime || null,
        projectId: session.projectId || null,
        trackId: session.trackId || null,
        launchOptions: session.launchOptions || null,
      };
      const interruptedBy = interruptionOf(sessionId, session, waitingReasons);
      if (interruptedBy) entry.interruptedBy = interruptedBy;
      out.push(entry);
    }
    return out;
  }

  /**
   * What a quit now would cut short in one live CLI session: its turn
   * ({ kind: 'busy' }) or the question or permission prompt it waits on
   * ({ kind: 'waiting', reason }). null when it sits idle at its prompt.
   * A resumed session comes back idle either way: the turn is not continued
   * and the pending question is not asked again. `waitingReasons` maps session
   * id → reason (the `claude agents` poller), keyed by the real id too.
   */
  function interruptionOf(sessionId, session, waitingReasons) {
    if (!session || session.isPlainTerminal || session.exited) return null;
    const reasons = waitingReasons instanceof Map ? waitingReasons : new Map(Object.entries(waitingReasons || {}));
    const reason = reasons.get(sessionId) || (session.realSessionId ? reasons.get(session.realSessionId) : null);
    if (reason) return { kind: 'waiting', reason: String(reason) };
    if (session._cliBusy) return { kind: 'busy' };
    return null;
  }

  /** The live CLI sessions a quit now would interrupt (see interruptionOf). */
  function sessionsInterruptedByQuit(activeSessions, waitingReasons) {
    const out = [];
    for (const [sessionId, session] of activeSessions || []) {
      const interruptedBy = interruptionOf(sessionId, session, waitingReasons);
      if (interruptedBy) out.push({ sessionId, projectPath: session.projectPath || null, interruptedBy });
    }
    return out;
  }

  /** One line per session for the quit dialog; `titleOf(entry)` names a session. */
  function quitWarningLines(interrupted, titleOf = entry => entry.sessionId.slice(0, 8)) {
    return interrupted.map(entry => {
      const what = entry.interruptedBy.kind === 'waiting' ? `waiting: ${entry.interruptedBy.reason}` : 'working';
      return `• ${titleOf(entry)} (${what})`;
    });
  }

  /** Row badge tooltip for a session resumed after being cut short by the quit. */
  function interruptedTooltip(interruptedBy) {
    if (interruptedBy?.kind === 'waiting') {
      return `Was waiting on you (${interruptedBy.reason}) when Switchboard quit. The question is gone: type to have it asked again.`;
    }
    return 'Was working when Switchboard quit: its turn was stopped. Type to continue.';
  }

  /** The value stored at quit; an empty list stores nothing. */
  function recordAtQuit({ globalSettings, activeSessions, waitingReasons = null, now = Date.now() }) {
    if (!resumeEnabled(globalSettings)) return null;
    const sessions = collectSessionsToResume(activeSessions, waitingReasons);
    return sessions.length ? { savedAt: now, sessions } : null;
  }

  /**
   * The recorded sessions to reopen now: the setting may have been turned off
   * since the quit, a session may already be open (a renderer reload), or
   * archived since. `lookup(id)` returns the renderer's row for a session.
   */
  function sessionsToReopen(stored, { globalSettings, isOpen = () => false, lookup = () => null } = {}) {
    if (!resumeEnabled(globalSettings)) return [];
    const list = Array.isArray(stored?.sessions) ? stored.sessions : [];
    const seen = new Set();
    const out = [];
    for (const saved of list) {
      const id = saved?.sessionId;
      if (!id || typeof saved.projectPath !== 'string' || seen.has(id)) continue;
      seen.add(id);
      if (isOpen(id)) continue;
      const row = lookup(id);
      if (row?.archived) continue;
      out.push({ saved, row: row || null });
    }
    return out;
  }

  /** Resume options: current defaults, overridden by what the session ran with. */
  function resumeOptions(defaults, saved, row) {
    const options = { ...(defaults || {}), ...(saved?.launchOptions || {}) };
    const runtime = row?.runtime || saved?.runtime;
    if (runtime) options.runtime = runtime;
    return options;
  }

  const api = {
    SETTING_KEY, resumeEnabled, collectSessionsToResume, recordAtQuit, sessionsToReopen, resumeOptions,
    interruptionOf, sessionsInterruptedByQuit, quitWarningLines, interruptedTooltip,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionsToResume = api;
})(typeof window !== 'undefined' ? window : globalThis);
