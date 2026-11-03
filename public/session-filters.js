// The Sessions-tab filter buttons (running, starred, today, archived). Each one
// has three states and a click moves to the next; the filters combine with AND.
//   running, starred, today: off → only → exclude → off
//   archived:                hide (the default) → include → only → hide
(function (root) {
  const FILTER_OFF = 'off';
  const FILTER_ONLY = 'only';
  const FILTER_EXCLUDE = 'exclude';
  const ARCHIVED_HIDE = 'hide';
  const ARCHIVED_INCLUDE = 'include';
  const ARCHIVED_ONLY = 'only';

  const SESSION_FILTER_CYCLE = [FILTER_OFF, FILTER_ONLY, FILTER_EXCLUDE];
  const ARCHIVED_FILTER_CYCLE = [ARCHIVED_HIDE, ARCHIVED_INCLUDE, ARCHIVED_ONLY];

  function defaultSessionFilters() {
    return { running: FILTER_OFF, starred: FILTER_OFF, today: FILTER_OFF, archived: ARCHIVED_HIDE };
  }

  function cycleFor(filterName) {
    return filterName === 'archived' ? ARCHIVED_FILTER_CYCLE : SESSION_FILTER_CYCLE;
  }

  /** The state a click moves `filterName` to. An unknown state restarts the cycle. */
  function nextFilterState(filterName, state) {
    const cycle = cycleFor(filterName);
    const at = cycle.indexOf(state);
    return cycle[(at + 1) % cycle.length];
  }

  /** "YYYY-MM-DD" in local time: the day a session counts as "today" for. */
  function localDayKey(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function modifiedToday(session, todayKey) {
    if (!session.modified) return false;
    const d = new Date(session.modified);
    return !Number.isNaN(d.getTime()) && localDayKey(d) === todayKey;
  }

  function passes(state, has) {
    if (state === FILTER_ONLY) return has;
    if (state === FILTER_EXCLUDE) return !has;
    return true;
  }

  /**
   * Whether `session` survives every filter. `isRunning(sessionId)` answers the
   * running filter; `todayKey` is localDayKey(now). The archived filter is
   * checked here too, so a caller handing in archived rows gets them dropped
   * unless the filter lets them through.
   */
  function sessionMatchesFilters(session, filters, { isRunning, todayKey }) {
    if (!passes(filters.running, isRunning(session.sessionId))) return false;
    if (!passes(filters.starred, !!session.starred)) return false;
    if (!passes(filters.today, modifiedToday(session, todayKey))) return false;
    const archived = !!session.archived;
    if (filters.archived === ARCHIVED_ONLY) return archived;
    if (filters.archived === ARCHIVED_INCLUDE) return true;
    return !archived;
  }

  /** Archived rows are needed in the source list unless the filter hides them. */
  function needsArchivedSessions(filters) {
    return filters.archived === ARCHIVED_INCLUDE || filters.archived === ARCHIVED_ONLY;
  }

  /**
   * A filter that narrows the list: every session it lets through is shown,
   * with no "+N older" cut and no auto-collapse. Showing archived rows
   * alongside the rest does not narrow anything.
   */
  function anyNarrowingFilter(filters) {
    return filters.running !== FILTER_OFF || filters.starred !== FILTER_OFF
      || filters.today !== FILTER_OFF || filters.archived === ARCHIVED_ONLY;
  }

  const FILTER_SUBJECTS = { running: 'running sessions', starred: 'starred sessions', today: "today's sessions" };

  /** Tooltip naming the current state and what a click does. */
  function filterTooltip(filterName, state) {
    if (filterName === 'archived') {
      if (state === ARCHIVED_INCLUDE) return 'Archived sessions: shown with the rest. Click: archived only';
      if (state === ARCHIVED_ONLY) return 'Archived sessions: only these. Click: hide archived';
      return 'Archived sessions: hidden. Click: show them too';
    }
    const subject = FILTER_SUBJECTS[filterName];
    if (state === FILTER_ONLY) return `Showing only ${subject}. Click: hide ${subject}`;
    if (state === FILTER_EXCLUDE) return `Hiding ${subject}. Click: clear this filter`;
    return `No filter on ${subject}. Click: show only ${subject}`;
  }

  const api = {
    FILTER_OFF, FILTER_ONLY, FILTER_EXCLUDE, ARCHIVED_HIDE, ARCHIVED_INCLUDE, ARCHIVED_ONLY,
    defaultSessionFilters, nextFilterState, localDayKey, sessionMatchesFilters,
    needsArchivedSessions, anyNarrowingFilter, filterTooltip,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
