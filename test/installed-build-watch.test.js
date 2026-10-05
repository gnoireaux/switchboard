const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

const {
  readInstalledBuildLabel, pendingInstalledBuild,
  pendingBuildTitleSuffix, createInstalledBuildWatcher,
} = require('../installed-build-watch');

// Packs a real archive the way electron-builder does, with a package.json
// carrying `buildLabel` and a second file so offsets are non-trivial.
async function packArchive(dir, buildLabel, name = 'app.asar') {
  const src = fs.mkdtempSync(path.join(dir, 'src-'));
  fs.writeFileSync(path.join(src, 'main.js'), 'x'.repeat(5000));
  const pkg = { name: 'switchboard', version: '0.0.36' };
  if (buildLabel !== undefined) pkg.buildLabel = buildLabel;
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg));
  const out = path.join(dir, name);
  await asar.createPackage(src, out);
  return out;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'installed-build-watch-'));
}

test('reads buildLabel out of a packed app.asar', async () => {
  const archive = await packArchive(tmpDir(), '  integration/rebuild-on-upstream@2df33f1 ');
  assert.equal(readInstalledBuildLabel(fs, archive), 'integration/rebuild-on-upstream@2df33f1');
});

test('an unlabelled archive reads as an empty label', async () => {
  const archive = await packArchive(tmpDir(), undefined);
  assert.equal(readInstalledBuildLabel(fs, archive), '');
});

test('a pending build needs two different, non-blank labels', () => {
  assert.equal(pendingInstalledBuild('main@aaa', 'main@bbb'), 'main@bbb');
  assert.equal(pendingInstalledBuild('main@aaa', ' main@aaa '), null);
  assert.equal(pendingInstalledBuild(undefined, 'main@bbb'), null);
  assert.equal(pendingInstalledBuild('main@aaa', ''), null);
});

test('title suffix shortens to the commit when the branch is unchanged', () => {
  assert.equal(pendingBuildTitleSuffix('integration/x@aaa1111', 'integration/x@bbb2222'), ' — ⟳ restart for @bbb2222');
  assert.equal(pendingBuildTitleSuffix('integration/x@aaa1111', 'feat/y@bbb2222'), ' — ⟳ restart for feat/y@bbb2222');
  assert.equal(pendingBuildTitleSuffix('integration/x@aaa1111', null), '');
});

test('watcher reports a build installed after launch, and its removal', async (t) => {
  const dir = tmpDir();
  const installed = await packArchive(dir, 'integration/x@aaa1111');
  const changes = [];
  const watcher = createInstalledBuildWatcher({
    fs, asarPath: installed, runningLabel: 'integration/x@aaa1111', onChange: (p) => changes.push(p),
  });

  await t.test('Given the running build is the installed one, nothing is pending', () => {
    assert.equal(watcher.check(), null);
    assert.deepEqual(changes, []);
  });

  await t.test('When a newer build replaces the archive (rsync: new file renamed over), it becomes pending once', async () => {
    const staged = await packArchive(dir, 'integration/x@bbb2222', 'staged.asar');
    fs.renameSync(staged, installed);
    assert.equal(watcher.check(), 'integration/x@bbb2222');
    assert.equal(watcher.check(), 'integration/x@bbb2222');
    assert.deepEqual(changes, ['integration/x@bbb2222']);
  });

  await t.test('When the running build is put back, pending clears', async () => {
    const staged = await packArchive(dir, 'integration/x@aaa1111', 'staged.asar');
    fs.renameSync(staged, installed);
    assert.equal(watcher.check(), null);
    assert.deepEqual(changes, ['integration/x@bbb2222', null]);
  });
});

test('watcher retries a half-copied archive on the next check', async () => {
  const dir = tmpDir();
  const installed = await packArchive(dir, 'integration/x@aaa1111');
  const complete = fs.readFileSync(await packArchive(dir, 'integration/x@ccc3333', 'next.asar'));
  const changes = [];
  const warnings = [];
  const watcher = createInstalledBuildWatcher({
    fs, asarPath: installed, runningLabel: 'integration/x@aaa1111',
    onChange: (p) => changes.push(p), log: { warn: (m) => warnings.push(m), info() {} },
  });

  fs.writeFileSync(installed, complete.subarray(0, 40));
  assert.equal(watcher.check(), null);
  assert.equal(warnings.length, 1);

  fs.writeFileSync(installed, complete);
  assert.equal(watcher.check(), 'integration/x@ccc3333');
  assert.deepEqual(changes, ['integration/x@ccc3333']);
});

test('watcher survives a missing archive', () => {
  const warnings = [];
  const watcher = createInstalledBuildWatcher({
    fs, asarPath: path.join(tmpDir(), 'gone.asar'), runningLabel: 'main@aaa',
    onChange: () => assert.fail('no change expected'), log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(watcher.check(), null);
  assert.equal(warnings.length, 1);
});
