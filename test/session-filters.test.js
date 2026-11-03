const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FILTER_OFF, FILTER_ONLY, FILTER_EXCLUDE, ARCHIVED_HIDE, ARCHIVED_INCLUDE, ARCHIVED_ONLY,
  defaultSessionFilters, nextFilterState, localDayKey, sessionMatchesFilters,
  needsArchivedSessions, anyNarrowingFilter, filterTooltip,
} = require('../public/session-filters');

const NOW = new Date(2026, 10, 3, 15, 0); // local time, 2026-11-03 15:00
const TODAY = localDayKey(NOW);
const EARLIER_TODAY = new Date(2026, 10, 3, 9, 0).toISOString();
const YESTERDAY = new Date(2026, 10, 2, 23, 0).toISOString();

const RUNNING_IDS = new Set(['running-starred-today', 'running-plain-old']);
const SESSIONS = [
  { sessionId: 'running-starred-today', starred: 1, modified: EARLIER_TODAY },
  { sessionId: 'running-plain-old', starred: 0, modified: YESTERDAY },
  { sessionId: 'idle-starred-old', starred: 1, modified: YESTERDAY },
  { sessionId: 'idle-plain-today', starred: 0, modified: EARLIER_TODAY },
  { sessionId: 'archived-starred-today', starred: 1, archived: 1, modified: EARLIER_TODAY },
  { sessionId: 'archived-plain-old', starred: 0, archived: 1, modified: YESTERDAY },
];

function shown(overrides) {
  const filters = { ...defaultSessionFilters(), ...overrides };
  const ctx = { isRunning: id => RUNNING_IDS.has(id), todayKey: TODAY };
  return SESSIONS.filter(s => sessionMatchesFilters(s, filters, ctx)).map(s => s.sessionId);
}

test('by default every filter is off and archived sessions are hidden', () => {
  assert.deepEqual(defaultSessionFilters(), { running: 'off', starred: 'off', today: 'off', archived: 'hide' });
  assert.deepEqual(shown({}), ['running-starred-today', 'running-plain-old', 'idle-starred-old', 'idle-plain-today']);
});

test('a click cycles running, starred and today through off, only, exclude', () => {
  for (const name of ['running', 'starred', 'today']) {
    assert.equal(nextFilterState(name, FILTER_OFF), FILTER_ONLY);
    assert.equal(nextFilterState(name, FILTER_ONLY), FILTER_EXCLUDE);
    assert.equal(nextFilterState(name, FILTER_EXCLUDE), FILTER_OFF);
  }
});

test('a click cycles archived through hide, include, only', () => {
  assert.equal(nextFilterState('archived', ARCHIVED_HIDE), ARCHIVED_INCLUDE);
  assert.equal(nextFilterState('archived', ARCHIVED_INCLUDE), ARCHIVED_ONLY);
  assert.equal(nextFilterState('archived', ARCHIVED_ONLY), ARCHIVED_HIDE);
});

test('an unknown state restarts the cycle', () => {
  assert.equal(nextFilterState('running', 'bogus'), FILTER_OFF);
  assert.equal(nextFilterState('archived', undefined), ARCHIVED_HIDE);
});

test('only keeps the matching sessions, exclude keeps the others', () => {
  assert.deepEqual(shown({ running: FILTER_ONLY }), ['running-starred-today', 'running-plain-old']);
  assert.deepEqual(shown({ running: FILTER_EXCLUDE }), ['idle-starred-old', 'idle-plain-today']);
  assert.deepEqual(shown({ starred: FILTER_ONLY }), ['running-starred-today', 'idle-starred-old']);
  assert.deepEqual(shown({ starred: FILTER_EXCLUDE }), ['running-plain-old', 'idle-plain-today']);
  assert.deepEqual(shown({ today: FILTER_ONLY }), ['running-starred-today', 'idle-plain-today']);
  assert.deepEqual(shown({ today: FILTER_EXCLUDE }), ['running-plain-old', 'idle-starred-old']);
});

test('filters combine with AND, running and starred included', () => {
  // Before tri-state filters, running-only and starred-only cancelled each other.
  assert.deepEqual(shown({ running: FILTER_ONLY, starred: FILTER_ONLY }), ['running-starred-today']);
  assert.deepEqual(shown({ running: FILTER_ONLY, starred: FILTER_EXCLUDE }), ['running-plain-old']);
  assert.deepEqual(shown({ running: FILTER_EXCLUDE, today: FILTER_EXCLUDE }), ['idle-starred-old']);
  assert.deepEqual(shown({ running: FILTER_ONLY, starred: FILTER_ONLY, today: FILTER_EXCLUDE }), []);
});

test('archived include adds archived rows, archived only keeps nothing else', () => {
  assert.deepEqual(shown({ archived: ARCHIVED_INCLUDE }), SESSIONS.map(s => s.sessionId));
  assert.deepEqual(shown({ archived: ARCHIVED_ONLY }), ['archived-starred-today', 'archived-plain-old']);
  assert.deepEqual(shown({ archived: ARCHIVED_ONLY, starred: FILTER_ONLY }), ['archived-starred-today']);
  assert.deepEqual(shown({ archived: ARCHIVED_INCLUDE, today: FILTER_EXCLUDE }), ['running-plain-old', 'idle-starred-old', 'archived-plain-old']);
});

test('today is the local calendar day, and a session without a date is never today', () => {
  const ctx = { isRunning: () => false, todayKey: TODAY };
  const filters = { ...defaultSessionFilters(), today: FILTER_ONLY };
  assert.equal(sessionMatchesFilters({ sessionId: 'x', modified: YESTERDAY }, filters, ctx), false);
  assert.equal(sessionMatchesFilters({ sessionId: 'x' }, filters, ctx), false);
  assert.equal(sessionMatchesFilters({ sessionId: 'x', modified: 'not a date' }, filters, ctx), false);
  const excluding = { ...filters, today: FILTER_EXCLUDE };
  assert.equal(sessionMatchesFilters({ sessionId: 'x' }, excluding, ctx), true, 'no date counts as not today');
});

test('archived rows are fetched only when the archived filter lets them through', () => {
  assert.equal(needsArchivedSessions(defaultSessionFilters()), false);
  assert.equal(needsArchivedSessions({ ...defaultSessionFilters(), archived: ARCHIVED_INCLUDE }), true);
  assert.equal(needsArchivedSessions({ ...defaultSessionFilters(), archived: ARCHIVED_ONLY }), true);
});

test('only and exclude narrow the list; showing archived alongside does not', () => {
  assert.equal(anyNarrowingFilter(defaultSessionFilters()), false);
  assert.equal(anyNarrowingFilter({ ...defaultSessionFilters(), archived: ARCHIVED_INCLUDE }), false);
  assert.equal(anyNarrowingFilter({ ...defaultSessionFilters(), archived: ARCHIVED_ONLY }), true);
  for (const name of ['running', 'starred', 'today']) {
    assert.equal(anyNarrowingFilter({ ...defaultSessionFilters(), [name]: FILTER_ONLY }), true, `${name} only`);
    assert.equal(anyNarrowingFilter({ ...defaultSessionFilters(), [name]: FILTER_EXCLUDE }), true, `${name} exclude`);
  }
});

test('the tooltip names the state and what the next click does', () => {
  assert.equal(filterTooltip('running', FILTER_OFF), 'No filter on running sessions. Click: show only running sessions');
  assert.equal(filterTooltip('starred', FILTER_ONLY), 'Showing only starred sessions. Click: hide starred sessions');
  assert.equal(filterTooltip('today', FILTER_EXCLUDE), "Hiding today's sessions. Click: clear this filter");
  assert.equal(filterTooltip('archived', ARCHIVED_HIDE), 'Archived sessions: hidden. Click: show them too');
  assert.equal(filterTooltip('archived', ARCHIVED_INCLUDE), 'Archived sessions: shown with the rest. Click: archived only');
  assert.equal(filterTooltip('archived', ARCHIVED_ONLY), 'Archived sessions: only these. Click: hide archived');
});
