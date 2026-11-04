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
  function collectSessionsToResume(activeSessions) {
    const out = [];
    for (const [sessionId, session] of activeSessions || []) {
      if (!session || session.isPlainTerminal || session.exited || session.pendingLaunch) continue;
      if (!session.projectPath) continue;
      out.push({
        sessionId,
        projectPath: session.projectPath,
        runtime: session.runtime || null,
        projectId: session.projectId || null,
        trackId: session.trackId || null,
        launchOptions: session.launchOptions || null,
      });
    }
    return out;
  }

  /** The value stored at quit; an empty list stores nothing. */
  function recordAtQuit({ globalSettings, activeSessions, now = Date.now() }) {
    if (!resumeEnabled(globalSettings)) return null;
    const sessions = collectSessionsToResume(activeSessions);
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

  const api = { SETTING_KEY, resumeEnabled, collectSessionsToResume, recordAtQuit, sessionsToReopen, resumeOptions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionsToResume = api;
})(typeof window !== 'undefined' ? window : globalThis);
