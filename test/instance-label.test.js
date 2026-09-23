const test = require('node:test');
const assert = require('node:assert/strict');

const { macBundleName, instanceLabel } = require('../instance-label');

test('macBundleName reads the .app name out of the executable path', () => {
  assert.equal(
    macBundleName('/Applications/Switchboard-fork.app/Contents/MacOS/Switchboard'),
    'Switchboard-fork',
  );
  assert.equal(macBundleName('/usr/local/bin/electron'), null);
  assert.equal(macBundleName(undefined), null);
});

test('upstream install keeps the plain name', () => {
  assert.equal(instanceLabel({
    execPath: '/Applications/Switchboard.app/Contents/MacOS/Switchboard',
    platform: 'darwin', isPackaged: true,
  }), 'Switchboard');
});

test('a fork built without a productName override is named by its bundle file', () => {
  assert.equal(instanceLabel({
    execPath: '/Applications/Switchboard-fork.app/Contents/MacOS/Switchboard',
    platform: 'darwin', isPackaged: true,
    buildLabel: 'integration/rebuild-on-upstream@b739326',
  }), 'Switchboard-fork — integration/rebuild-on-upstream@b739326');
});

test('a dev bundle shows its bundle name and stamped build', () => {
  assert.equal(instanceLabel({
    execPath: '/Applications/Switchboard-dev-x.app/Contents/MacOS/Switchboard-dev-x',
    platform: 'darwin', isPackaged: true, buildLabel: '  feat/x@1234567 ',
    dataDir: '/Users/me/.switchboard-dev-x',
  }), 'Switchboard-dev-x — feat/x@1234567');
});

test('a source run says so and names its data dir', () => {
  assert.equal(instanceLabel({
    execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    platform: 'darwin', isPackaged: false, dataDir: '/Users/me/.switchboard-dev',
  }), 'Switchboard (from source) — /Users/me/.switchboard-dev');
});

test('non-mac packaged builds fall back to the plain name', () => {
  assert.equal(instanceLabel({
    execPath: 'C:\\Program Files\\Switchboard\\Switchboard.exe',
    platform: 'win32', isPackaged: true, buildLabel: 'main@abc1234',
  }), 'Switchboard — main@abc1234');
});
