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

const { togglePinnedFolderAndSave } = require('../public/folder-pins');

function saveRecorder({ setSetting, getSetting } = {}) {
  const applied = [], stored = [], errors = [];
  return {
    applied, stored, errors,
    deps: {
      setSetting: setSetting || (async (key, value) => { stored.push([key, value]); }),
      getSetting: getSetting || (async () => null),
      apply: paths => applied.push(paths),
      logError: err => errors.push(err.message),
    },
  };
}

test('a pin toggle shows at once, then is stored under the pins key', async () => {
  const r = saveRecorder();
  await togglePinnedFolderAndSave(['/a'], '/b', r.deps);
  assert.deepEqual(r.applied, [['/a', '/b']]);
  assert.deepEqual(r.stored, [['pinnedSessionFolders', ['/a', '/b']]]);
  assert.deepEqual(r.errors, []);
});

test('a pin whose write fails is replaced on screen by what the database still holds', async () => {
  const r = saveRecorder({
    setSetting: async () => { throw new Error('disk full'); },
    getSetting: async () => ['/a', '/other-window'],
  });
  await togglePinnedFolderAndSave(['/a'], '/b', r.deps);
  assert.deepEqual(r.applied, [['/a', '/b'], ['/a', '/other-window']]);
  assert.deepEqual(r.errors, ['disk full']);
});

test('when the database cannot be read back either, the list from before the click returns', async () => {
  const r = saveRecorder({
    setSetting: async () => { throw new Error('disk full'); },
    getSetting: async () => { throw new Error('closed'); },
  });
  await togglePinnedFolderAndSave(['/a', '/b'], '/a', r.deps);
  assert.deepEqual(r.applied, [['/b'], ['/a', '/b']]);
});
