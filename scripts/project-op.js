#!/usr/bin/env node
// Asks a running Switchboard to make a Projects-tab edit — create a project,
// attach or detach a folder, rename, add a track, file a session — through the
// launch socket. The app runs its own code for it, so the project brief is
// rewritten and the window refreshes as after a click.
//
//   node scripts/project-op.js project.attachFolder '{"projectId":"…","path":"/abs/folder"}'
//   node scripts/project-op.js projects            # the project tree, as JSON
//
// The args are a JSON object, given as the second argument, or read from stdin
// when that argument is "-"; none means {}. The reply is printed as JSON. Ops and their args:
//   projects             {showArchived?}
//   project.create       {name, folders?: [{path, mode?: "in-place"|"worktree", branch?}], template?}
//   project.update       {projectId, name?, status?, defaultCwd?}
//   project.attachFolder {projectId, path, mode?, branch?}
//   project.detachFolder {projectId, path}        (rows only; the folder stays on disk)
//   track.create         {projectId, name, cwd?, cli?}
//   track.update         {trackId, name?, cwd?, cli?, status?, sortOrder?}
//   session.assign       {sessionId, projectId?, trackId?}   (no projectId = unfile)
// Nothing here deletes a project, a track or a session.
//
// Exit status: 0 done, 1 refused or unreachable, 2 bad usage, 3 the running
// Switchboard predates project ops (it answers "unknown request type").

const fs = require('fs');
const { defaultLaunchPaths } = require('../launch-socket-server');
const { askSwitchboard } = require('./launch-session');

const EXIT_PREDATES_PROJECT_OPS = 3;

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function parseOpArgs(raw) {
  if (!raw.trim()) return {};
  const args = JSON.parse(raw);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be a JSON object');
  return args;
}

async function main() {
  const [op, rawArgs] = process.argv.slice(2);
  if (!op || op.startsWith('-')) {
    process.stderr.write('usage: project-op.js <op> [json-args | -]\n');
    process.exit(2);
  }
  let args;
  try {
    args = parseOpArgs(rawArgs === '-' ? await readStdin() : rawArgs || '');
  } catch (err) {
    process.stderr.write(`bad args: ${err.message}\n`);
    process.exit(2);
  }

  const { socketPath, tokenPath } = defaultLaunchPaths();
  let token;
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    process.stderr.write(`no launch token at ${tokenPath} — start Switchboard once to create it\n`);
    process.exit(1);
  }

  let reply;
  try {
    reply = await askSwitchboard(socketPath, { token, type: 'project-op', op, args });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  if (reply.ok) {
    process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`);
    return;
  }
  if (reply.error === 'unknown request type') {
    process.stderr.write(`the Switchboard on ${socketPath} predates project ops\n`);
    process.exit(EXIT_PREDATES_PROJECT_OPS);
  }
  process.stderr.write(`${op} refused: ${reply.error}\n`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = { parseOpArgs, EXIT_PREDATES_PROJECT_OPS };
