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

// Claude and Codex session ids are UUIDs; this is looser so a future id
// format still passes, and strict enough to keep junk out of logs.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
  // A read of live session state rather than a launch: same socket and token,
  // since who may read which sessions wait on the user is the same question.
  if (parsed.type === 'session-states') return { ok: true, request: { type: 'session-states' } };
  // What this build's launches understand, so a caller can tell an older
  // Switchboard (which answers "unknown request type") from one that applies
  // what it sends.
  if (parsed.type === 'features') return { ok: true, request: { type: 'features' } };
  if (parsed.type !== undefined && parsed.type !== 'launch') return { ok: false, error: 'unknown request type' };
  const cwd = parsed.cwd;
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'cwd is required' };
  if (!path.isAbsolute(cwd)) return { ok: false, error: 'cwd must be an absolute path' };
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
  // The spawner's session id: the successor joins the spawner's project and
  // track. Optional; when present it must look like an id, since it ends up in
  // a database lookup and a log line.
  let inheritFrom = null;
  if (parsed.inheritFrom !== undefined && parsed.inheritFrom !== null) {
    if (typeof parsed.inheritFrom !== 'string' || !SESSION_ID_PATTERN.test(parsed.inheritFrom)) {
      return { ok: false, error: 'inheritFrom must be a session id' };
    }
    inheritFrom = parsed.inheritFrom;
  }
  // Session settings the caller asks for (model, effort…), on top of what the
  // successor inherits. Only the shape is checked here; which settings an
  // external launch may set is the main process's call, per CLI.
  let options = null;
  if (parsed.options !== undefined && parsed.options !== null) {
    if (typeof parsed.options !== 'object' || Array.isArray(parsed.options)) {
      return { ok: false, error: 'options must be an object' };
    }
    options = parsed.options;
  }
  return {
    ok: true,
    request: { type: 'launch', cwd: path.normalize(cwd), prompt, autoSubmit: parsed.autoSubmit === true, inheritFrom, options },
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

// Launch request fields beyond cwd/prompt/autoSubmit/inheritFrom that this
// build applies; answered to a 'features' request.
const LAUNCH_FEATURES = ['options'];

// onLaunch(request) -> { ok: true, ... } | { ok: false, error }, may be async.
// onSessionStates() -> { ok: true, sessions } answers a 'session-states' request.
async function startLaunchSocketServer({ socketPath, token, onLaunch, onSessionStates = null, logger = null }) {
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
      if (parsed.request.type === 'features') return reply({ ok: true, features: LAUNCH_FEATURES });
      if (parsed.request.type === 'session-states') {
        if (!onSessionStates) return reply({ ok: false, error: 'session states not available' });
        try {
          return reply(await onSessionStates());
        } catch (err) {
          return reply({ ok: false, error: err?.message || 'session states failed' });
        }
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
  LAUNCH_FEATURES,
  defaultLaunchPaths,
  ensureLaunchToken,
  tokensMatch,
  parseLaunchRequest,
  clearStaleSocket,
  startLaunchSocketServer,
};
