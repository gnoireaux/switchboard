// How the Sessions tab applies its filters and folder pins: sidebar.js
// wiring around the pure helpers of session-filters.js and folder-pins.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const sidebar = read('sidebar.js');
const slice = (start, end) => sidebar.slice(sidebar.indexOf(start), sidebar.indexOf(end));
const sidebarSource = slice('function processProjectSessions(', '// Build the sessions list DOM')
  + slice('// The folder groups in display order', 'function renderProjects(');

const NOW = Date.now();
const DAY = 86400000;
const session = (sessionId, extra = {}) => ({ sessionId, modified: new Date(NOW - 60000).toISOString(), ...extra });

function harness({ visibleSessionCount = 2 } = {}) {
  const context = vm.createContext({
    searchMatchIds: null, activePtyIds: new Set(), sortedOrder: [],
    visibleSessionCount, sessionMaxAgeDays: 7, pinnedFolderPaths: new Set(),
    buildSessionItem: s => ({ id: `item-${s.sessionId}` }),
    buildSlugGroup: slug => ({ id: `slug-${slug}` }),
  });
  context.isSessionRunning = id => context.activePtyIds.has(id);
  vm.runInContext(read('session-filters.js') + read('folder-pins.js') + sidebarSource, context);
  context.sessionFilterStates = context.defaultSessionFilters();
  return context;
}

// Arrays made inside the vm context have its own Array prototype: copy them
// out before a strict deep comparison.
const ids = items => Array.from(items, item => item.element.id).sort();
const shown = result => result && ids(result.visible);
const older = result => result && ids(result.older);

test('a search finds archived sessions while they are hidden, and only them when set to only', () => {
  const h = harness();
  const project = { projectPath: '/p', sessions: [session('live'), session('old', { archived: 1 })] };

  assert.deepEqual(shown(h.processProjectSessions(project, true)), ['item-live'], 'no search: archived hidden');

  h.searchMatchIds = new Set(['live', 'old']);
  assert.deepEqual(shown(h.processProjectSessions(project, true)), ['item-live', 'item-old']);

  h.sessionFilterStates = { ...h.sessionFilterStates, archived: 'only' };
  assert.deepEqual(shown(h.processProjectSessions(project, true)), ['item-old']);
});

test('a narrowing filter shows every match; archived shown alongside keeps the "older" cut', () => {
  const h = harness({ visibleSessionCount: 2 });
  const project = { projectPath: '/p', sessions: ['s1', 's2', 's3', 's4'].map(id => session(id)) };

  const plain = h.processProjectSessions(project, true);
  assert.equal(plain.visible.length, 2);
  assert.equal(plain.older.length, 2);

  h.sessionFilterStates = { ...h.sessionFilterStates, archived: 'include' };
  assert.equal(h.processProjectSessions(project, true).older.length, 2, 'include does not narrow');

  h.sessionFilterStates = { ...h.defaultSessionFilters(), today: 'only' };
  const narrowed = h.processProjectSessions(project, true);
  assert.equal(narrowed.visible.length, 4);
  assert.deepEqual(older(narrowed), []);
});

test('exclude hides the matching sessions and drops a group left empty', () => {
  const h = harness();
  h.activePtyIds = new Set(['run']);
  const mixed = { projectPath: '/p', sessions: [session('run'), session('idle')] };
  const allRunning = { projectPath: '/q', sessions: [session('run')] };
  h.sessionFilterStates = { ...h.sessionFilterStates, running: 'exclude' };

  assert.deepEqual(shown(h.processProjectSessions(mixed, true)), ['item-idle']);
  assert.equal(h.processProjectSessions(allRunning, true), null);
});

test('filters combine: starred only and today excluded leaves starred sessions from earlier days', () => {
  const h = harness();
  const project = { projectPath: '/p', sessions: [
    session('star-today', { starred: 1 }),
    session('star-old', { starred: 1, modified: new Date(NOW - 3 * DAY).toISOString() }),
    session('plain-old', { modified: new Date(NOW - 3 * DAY).toISOString() }),
  ] };
  h.sessionFilterStates = { ...h.sessionFilterStates, starred: 'only', today: 'exclude' };
  assert.deepEqual(shown(h.processProjectSessions(project, true)), ['item-star-old']);
});

const groups = (...paths) => paths.map(projectPath => ({ projectPath, sessions: [] }));
const pathsOf = projects => Array.from(projects, p => p.projectPath);

test('pinned groups go on top of a resort, in data order otherwise', () => {
  const h = harness();
  h.pinnedFolderPaths = vm.runInContext("new Set(['/c'])", h); // folder-pins checks instanceof Set
  assert.deepEqual(pathsOf(h.orderProjectGroups(groups('/a', '/b', '/c'), true)), ['/c', '/a', '/b']);
});

test('pinned groups go on top of the order kept on screen; a new group leads the unpinned ones', () => {
  const h = harness();
  h.pinnedFolderPaths = vm.runInContext("new Set(['/c'])", h); // folder-pins checks instanceof Set
  h.sortedOrder = [{ projectPath: '/b' }, { projectPath: '/a' }, { projectPath: '/c' }];
  assert.deepEqual(pathsOf(h.orderProjectGroups(groups('/a', '/b', '/c'), false)), ['/c', '/b', '/a']);
  assert.deepEqual(pathsOf(h.orderProjectGroups(groups('/a', '/b', '/c', '/d'), false)), ['/c', '/d', '/b', '/a']);
});
