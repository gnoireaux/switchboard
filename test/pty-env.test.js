const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPtyEnv } = require('../pty-env');

test('strips Electron internals that break nested Electron / node-pty', () => {
  const env = buildPtyEnv({
    ELECTRON_RUN_AS_NODE: '1',
    GOOGLE_API_KEY: 'secret',
    NODE_OPTIONS: '--inspect',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    WT_SESSION: 'abc',
    PATH: '/usr/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', 'LC_CTYPE', 'PATH']);
});

test('the launching session\'s identity does not reach the session it starts', () => {
  // Switchboard started from a shell inside a Claude session: the marker would
  // turn every session it spawns into a transcript-less nested run, and the
  // session id would point hooks at the wrong transcript.
  const env = buildPtyEnv({
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
    PATH: '/usr/bin',
  });
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192', 'deliberate configuration is the user\'s');
  assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '1', 'Switchboard needs the transcript');
});

test('sets a UTF-8 LC_CTYPE when the parent env has no locale at all', () => {
  // The macOS Finder/Dock launch case: launchd sets no LANG, so pbcopy would
  // fall back to Mac OS Roman and mangle UTF-8 on the way to the clipboard.
  assert.equal(buildPtyEnv({ PATH: '/usr/bin' }).LC_CTYPE, 'UTF-8');
});

test('an inherited locale wins — we do not override the user', () => {
  for (const inherited of [{ LANG: 'de_DE.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8' }, { LC_CTYPE: 'fr_FR.ISO8859-1' }]) {
    const env = buildPtyEnv({ ...inherited });
    assert.deepEqual(env, { ...inherited, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
  }
});

test('an empty locale value counts as absent', () => {
  // launchctl reports LANG as empty rather than unset on some macOS setups;
  // an empty string gives pbcopy nothing to work with either.
  assert.equal(buildPtyEnv({ LANG: '' }).LC_CTYPE, 'UTF-8');
});
