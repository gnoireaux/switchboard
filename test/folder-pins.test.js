const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PINNED_FOLDERS_SETTING_KEY, normalizePinnedFolders, togglePinnedFolder, orderPinnedFoldersFirst,
} = require('../public/folder-pins');

const folders = (...paths) => paths.map(projectPath => ({ projectPath, sessions: [] }));
const pathsOf = projects => projects.map(p => p.projectPath);

test('the pins live under one settings key', () => {
  assert.equal(PINNED_FOLDERS_SETTING_KEY, 'pinnedSessionFolders');
});

test('normalizePinnedFolders keeps distinct non-empty paths and drops anything else', () => {
  assert.deepEqual(normalizePinnedFolders(null), [], 'nothing stored yet');
  assert.deepEqual(normalizePinnedFolders('/a'), [], 'a bare string is not a list');
  assert.deepEqual(normalizePinnedFolders({ '/a': true }), []);
  assert.deepEqual(normalizePinnedFolders(['/a', '', 3, null, '/b', '/a']), ['/a', '/b']);
});

test('togglePinnedFolder pins an unpinned folder and unpins a pinned one', () => {
  assert.deepEqual(togglePinnedFolder([], '/a'), ['/a']);
  assert.deepEqual(togglePinnedFolder(['/a'], '/b'), ['/a', '/b'], 'a new pin goes last');
  assert.deepEqual(togglePinnedFolder(['/a', '/b'], '/a'), ['/b']);
  assert.deepEqual(togglePinnedFolder(null, '/a'), ['/a'], 'a missing setting starts empty');
});

test('togglePinnedFolder leaves its input untouched', () => {
  const stored = ['/a'];
  togglePinnedFolder(stored, '/b');
  togglePinnedFolder(stored, '/a');
  assert.deepEqual(stored, ['/a']);
});

test('orderPinnedFoldersFirst moves pinned groups above the rest', () => {
  const ordered = orderPinnedFoldersFirst(folders('/a', '/b', '/c', '/d'), new Set(['/c']));
  assert.deepEqual(pathsOf(ordered), ['/c', '/a', '/b', '/d']);
});

test('orderPinnedFoldersFirst keeps the incoming order within each side', () => {
  // The caller decides recency or on-screen order; pinning only partitions.
  const ordered = orderPinnedFoldersFirst(folders('/d', '/a', '/c', '/b'), new Set(['/b', '/d']));
  assert.deepEqual(pathsOf(ordered), ['/d', '/b', '/a', '/c']);
});

test('orderPinnedFoldersFirst accepts the stored array as well as a Set', () => {
  const ordered = orderPinnedFoldersFirst(folders('/a', '/b'), ['/b']);
  assert.deepEqual(pathsOf(ordered), ['/b', '/a']);
});

test('orderPinnedFoldersFirst returns the same list when nothing is pinned', () => {
  const projects = folders('/a', '/b');
  assert.equal(orderPinnedFoldersFirst(projects, new Set()), projects);
});

test('a pin on a folder with no group on screen changes nothing', () => {
  const ordered = orderPinnedFoldersFirst(folders('/a', '/b'), new Set(['/gone']));
  assert.deepEqual(pathsOf(ordered), ['/a', '/b']);
});
