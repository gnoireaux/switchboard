#!/usr/bin/env node
// Prints which sessions a running Switchboard sees waiting on the user or
// scrolled up, as JSON: { sessionId: { waitingFor?, scrolledUp? } }.
//
//   node scripts/session-states.js
//
// A live answer from the launch socket. The same state is in
// $SWITCHBOARD_DATA_DIR/session-states.json (default ~/.switchboard), which
// needs no client; this is for callers that want it straight from the app.

const net = require('net');
const fs = require('fs');
const { defaultLaunchPaths } = require('../launch-socket-server');

function main() {
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
  socket.on('connect', () => socket.write(`${JSON.stringify({ token, type: 'session-states' })}\n`));

  let reply = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { reply += chunk; });
  socket.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(reply); } catch { parsed = { ok: false, error: `unreadable reply: ${reply}` }; }
    if (!parsed.ok) {
      process.stderr.write(`Switchboard refused: ${parsed.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(parsed.sessions, null, 2)}\n`);
  });
}

main();
