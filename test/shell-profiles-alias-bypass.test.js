const test = require('node:test');
const assert = require('node:assert/strict');

const { binaryBypassingShellAliases } = require('../shell-profiles');

test('POSIX shells and fish skip a same-named alias or function with `command`', () => {
  for (const shell of ['/bin/bash', '/bin/zsh', '/bin/sh', '/opt/homebrew/bin/fish']) {
    assert.equal(binaryBypassingShellAliases(shell, 'claude'), 'command claude', shell);
  }
});

test('nushell uses its external-command sigil', () => {
  assert.equal(binaryBypassingShellAliases('/opt/homebrew/bin/nu', 'claude'), '^claude');
});

test('shells without such a builtin get the bare binary', () => {
  assert.equal(binaryBypassingShellAliases('C:\\Windows\\System32\\cmd.exe', 'claude'), 'claude');
  assert.equal(binaryBypassingShellAliases('pwsh', 'claude'), 'claude');
});
