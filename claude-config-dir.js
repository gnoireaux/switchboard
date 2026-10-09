// claude-config-dir.js — Where the `claude` CLI keeps its state.
// CLAUDE_CONFIG_DIR relocates all of it (transcripts, plans, ide lockfiles,
// stats); an instance started with it set must read and write under that dir,
// never ~/.claude. Taken as-is, not resolved: claude-auth hashes this exact
// string into the keychain service name.
const path = require('path');
const os = require('os');

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

module.exports = { claudeConfigDir };
