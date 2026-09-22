// A local-only entry point for launching a session in Switchboard: a Unix
// domain socket plus a 0600 token file, both under ~/.switchboard.
//
// Why a socket rather than a switchboard:// URL scheme: the scheme is
// unauthenticated by nature — any local app, and any web page the user visits,
// could fire it — and it collides between the packaged app and a dev copy.
// Filesystem permissions answer "who may enqueue a prompt" without any of that.
//
// The server never starts a session itself. It validates a request and hands it
// to onLaunch; the human still sees the prompt in a real terminal.

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SOCKET_FILE = 'launch.sock';
const TOKEN_FILE = 'launch-token';

// A request bigger than this is junk or an attack, not a prompt.
const MAX_REQUEST_BYTES = 64 * 1024;

// The socket lives in the data dir, not the home dir: an instance started with
// SWITCHBOARD_DATA_DIR is a separate app with its own sessions, and a caller
// exporting the same variable reaches that instance rather than the installed
// one. Both sides derive the path the same way, so neither hard-codes it.
function defaultLaunchPaths(homeDir = os.homedir(), dataDir = process.env.SWITCHBOARD_DATA_DIR) {
  const dir = dataDir ? path.resolve(dataDir) : path.join(homeDir, '.switchboard');
  return { dir, socketPath: path.join(dir, SOCKET_FILE), tokenPath: path.join(dir, TOKEN_FILE) };
}

// Creates the token on first use and keeps it 0600 afterwards — a token file
// left group- or world-readable would hand the entry point to every local user.
function ensureLaunchToken(tokenPath) {
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(tokenPath)) {
    fs.chmodSync(tokenPath, 0o600);
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  return token;
}

// Length-independent comparison: timingSafeEqual throws on a length mismatch,
// and the lengths themselves are not secret.
function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Validates one request line. Returns { ok: true, request } or { ok: false, error }.
// `cwd` must be absolute: a relative path would resolve against whatever
// directory the app happens to have, which is not what the caller meant.
function parseLaunchRequest(raw, expectedToken) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'request must be an object' };
  }
  if (!tokensMatch(parsed.token, expectedToken)) return { ok: false, error: 'bad token' };
  const cwd = parsed.cwd;
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'cwd is required' };
  if (!path.isAbsolute(cwd)) return { ok: false, error: 'cwd must be an absolute path' };
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
  return {
    ok: true,
    request: { cwd: path.normalize(cwd), prompt, autoSubmit: parsed.autoSubmit === true },
  };
}

// Removes a socket file left behind by a crash. A socket nobody is listening on
// refuses connections; one that answers belongs to a live instance and is left
// alone, so a second Switchboard fails to listen instead of stealing the path.
function clearStaleSocket(socketPath) {
  return new Promise(resolve => {
    if (!fs.existsSync(socketPath)) return resolve(false);
    const probe = net.connect(socketPath);
    const giveUp = () => { probe.destroy(); resolve(false); };
    probe.setTimeout(500, giveUp);
    probe.on('connect', giveUp);
    probe.on('error', () => {
      probe.destroy();
      try { fs.unlinkSync(socketPath); } catch { /* raced with another cleanup */ }
      resolve(true);
    });
  });
}

// onLaunch(request) -> { ok: true, ... } | { ok: false, error }, may be async.
async function startLaunchSocketServer({ socketPath, token, onLaunch, logger = null }) {
  await clearStaleSocket(socketPath);

  const server = net.createServer(socket => {
    let buffer = '';
    let handled = false;
    const reply = payload => {
      if (handled) return;
      handled = true;
      socket.end(`${JSON.stringify(payload)}\n`);
    };
    socket.setEncoding('utf8');
    socket.on('data', async chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) return reply({ ok: false, error: 'request too large' });
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      const parsed = parseLaunchRequest(line, token);
      if (!parsed.ok) {
        logger?.warn?.(`[launch-socket] rejected: ${parsed.error}`);
        return reply({ ok: false, error: parsed.error });
      }
      try {
        const result = await onLaunch(parsed.request);
        reply(result || { ok: true });
      } catch (err) {
        logger?.error?.(`[launch-socket] launch failed: ${err?.message || String(err)}`);
        reply({ ok: false, error: err?.message || 'launch failed' });
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // The socket path itself is the outer gate; the token is the inner one.
  try { fs.chmodSync(socketPath, 0o600); } catch { /* not fatal, the token still guards */ }
  logger?.info?.(`[launch-socket] listening on ${socketPath}`);

  return {
    server,
    close: () => new Promise(resolve => {
      server.close(() => {
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
        resolve();
      });
    }),
  };
}

module.exports = {
  MAX_REQUEST_BYTES,
  defaultLaunchPaths,
  ensureLaunchToken,
  tokensMatch,
  parseLaunchRequest,
  clearStaleSocket,
  startLaunchSocketServer,
};
