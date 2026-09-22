#!/usr/bin/env node
// Asks a running Switchboard to start a session — the client side of the launch
// socket. A Claude session chaining into its successor runs this instead of
// `open -a iTerm <.command>`.
//
//   node scripts/launch-session.js --cwd /path/to/project \
//     --prompt '/stream-handoffs--chain-sessions continue /abs/chain-.../' --send
//
// --send presses Enter for the successor; without it the prompt waits in the
// input box. Reads the prompt from stdin when --prompt is omitted.

const net = require('net');
const fs = require('fs');
const { defaultLaunchPaths } = require('../launch-socket-server');

function parseArgs(argv) {
  const args = { cwd: process.cwd(), prompt: null, autoSubmit: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') args.cwd = argv[++i];
    else if (arg === '--prompt') args.prompt = argv[++i];
    else if (arg === '--send') args.autoSubmit = true;
    else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return args;
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt !== null ? args.prompt : await readStdin();
  const { socketPath, tokenPath } = defaultLaunchPaths();

  let token;
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    process.stderr.write(`no launch token at ${tokenPath} — start Switchboard once to create it\n`);
    process.exit(1);
  }

  const socket = net.connect(socketPath);
  socket.on('error', err => {
    process.stderr.write(`cannot reach Switchboard on ${socketPath}: ${err.message}\n`);
    process.exit(1);
  });
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ token, cwd: args.cwd, prompt, autoSubmit: args.autoSubmit })}\n`);
  });

  let reply = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { reply += chunk; });
  socket.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(reply); } catch { parsed = { ok: false, error: `unreadable reply: ${reply}` }; }
    if (parsed.ok) {
      process.stdout.write(`launched in ${args.cwd}\n`);
      return;
    }
    process.stderr.write(`launch refused: ${parsed.error}\n`);
    process.exit(1);
  });
}

main();
