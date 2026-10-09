const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { claudeConfigDir } = require('../claude-config-dir');

const DEFAULT_DIR = path.join(os.homedir(), '.claude');

test('defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset or empty', () => {
  assert.equal(claudeConfigDir({}), DEFAULT_DIR);
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }), DEFAULT_DIR);
});

test('follows CLAUDE_CONFIG_DIR when set', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/profiles/perso' }), '/profiles/perso');
});

// The other sites read the dir once at module load, so check them in a fresh
// process with the variable set, and without it.
function rootsSeenByModules(env) {
  const script = `
    const claude = require('./harnesses/claude');
    const auth = require('./claude-auth');
    console.log(JSON.stringify({ transcripts: claude.sessionsRoot(), auth: auth.getConfigDir() }));
  `;
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('transcript root and auth follow CLAUDE_CONFIG_DIR', () => {
  const { CLAUDE_CONFIG_DIR, ...rest } = process.env;
  assert.deepEqual(rootsSeenByModules({ ...rest, CLAUDE_CONFIG_DIR: '/profiles/perso' }),
    { transcripts: '/profiles/perso/projects', auth: '/profiles/perso' });
  assert.deepEqual(rootsSeenByModules(rest),
    { transcripts: path.join(DEFAULT_DIR, 'projects'), auth: DEFAULT_DIR });
});
