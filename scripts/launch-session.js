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
//
// The successor joins the caller's Switchboard project and track: the caller's
// session id (CLAUDE_CODE_SESSION_ID, set by Claude Code in its tool shells) is
// sent as inheritFrom. --inherit-from <id> names another session; --no-inherit
// sends none, and the successor is filed by its folder alone.
//
// --effort, --model and --permission-mode set those session settings, and
// --option key=value sends any other key (Switchboard refuses every key but
// those three, and a mode looser than the caller's launch mode); they win over
// what the successor inherits from the caller's launch options. An empty value
// asks for the CLI's own default.
//
// --features launches nothing: it prints, one per line, the request fields the
// running Switchboard applies ("options" = the settings above), and fails on a
// Switchboard too old to say — one that would silently ignore them.

const net = require('net');
const fs = require('fs');
const { defaultLaunchPaths } = require('../launch-socket-server');

function parseArgs(argv, env = process.env) {
  const args = {
    cwd: process.cwd(), prompt: null, autoSubmit: false,
    inheritFrom: env.CLAUDE_CODE_SESSION_ID || null,
    options: {}, features: false,
  };
  const SETTING_FLAGS = { '--effort': 'effort', '--model': 'model', '--permission-mode': 'permissionMode' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') args.cwd = argv[++i];
    else if (arg === '--prompt') args.prompt = argv[++i];
    else if (arg === '--send') args.autoSubmit = true;
    else if (arg === '--inherit-from') args.inheritFrom = argv[++i] || null;
    else if (arg === '--no-inherit') args.inheritFrom = null;
    else if (arg === '--features') args.features = true;
    else if (SETTING_FLAGS[arg]) args.options[SETTING_FLAGS[arg]] = argv[++i] ?? '';
    else if (arg === '--option') {
      const pair = argv[++i] || '';
      const eq = pair.indexOf('=');
      if (eq < 1) {
        process.stderr.write(`--option needs key=value, got: ${pair}\n`);
        process.exit(2);
      }
      args.options[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
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
  const prompt = args.features ? '' : args.prompt !== null ? args.prompt : await readStdin();
  const { socketPath, tokenPath } = defaultLaunchPaths();

  let token;
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    process.stderr.write(`no launch token at ${tokenPath} — start Switchboard once to create it\n`);
    process.exit(1);
  }

  const payload = args.features ? { token, type: 'features' } : { token, cwd: args.cwd, prompt, autoSubmit: args.autoSubmit };
  if (!args.features && args.inheritFrom) payload.inheritFrom = args.inheritFrom;
  if (!args.features && Object.keys(args.options).length) payload.options = args.options;

  let parsed;
  try {
    parsed = await askSwitchboard(socketPath, payload);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  if (parsed.ok && args.features) {
    process.stdout.write((parsed.features || []).map(f => `${f}\n`).join(''));
    return;
  }
  if (parsed.ok) {
    const filed = parsed.projectId ? ` (project ${parsed.projectId}${parsed.trackId ? `, track ${parsed.trackId}` : ''})` : '';
    process.stdout.write(`launched in ${args.cwd}${filed}\n`);
    return;
  }
  process.stderr.write(`${args.features ? 'features' : 'launch'} refused: ${parsed.error}\n`);
  process.exit(1);
}

// A Switchboard whose main process is stuck still accepts the connection, and
// a caller chaining into its successor would wait on it forever.
const REPLY_TIMEOUT_MS = 10000;

// Sends one request and resolves with Switchboard's parsed reply; rejects when
// the socket is unreachable or no reply comes within timeoutMs.
function askSwitchboard(socketPath, payload, timeoutMs = REPLY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`no reply from Switchboard on ${socketPath} within ${timeoutMs / 1000}s`));
    });
    socket.on('error', err => reject(new Error(`cannot reach Switchboard on ${socketPath}: ${err.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => {
      try { resolve(JSON.parse(reply)); } catch { resolve({ ok: false, error: `unreadable reply: ${reply}` }); }
    });
  });
}

if (require.main === module) main();

module.exports = { parseArgs, askSwitchboard };
