const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const {
  defaultLaunchPaths, ensureLaunchToken, tokensMatch, parseLaunchRequest,
  clearStaleSocket, startLaunchSocketServer,
} = require('../launch-socket-server');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-launch-test-'));
}

// Sends one request line and resolves with the parsed reply.
function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      socket.write(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
    });
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', d => { out += d; });
    socket.on('end', () => {
      try { resolve(JSON.parse(out)); } catch (err) { reject(err); }
    });
    socket.on('error', reject);
  });
}

test('the default paths live under ~/.switchboard', () => {
  const paths = defaultLaunchPaths('/home/someone');
  assert.equal(paths.socketPath, '/home/someone/.switchboard/launch.sock');
  assert.equal(paths.tokenPath, '/home/someone/.switchboard/launch-token');
});

test('SWITCHBOARD_DATA_DIR moves the socket to that instance\u2019s own data dir', () => {
  const paths = defaultLaunchPaths('/home/someone', '/home/someone/.switchboard-dev');
  assert.equal(paths.socketPath, '/home/someone/.switchboard-dev/launch.sock');
  assert.equal(paths.tokenPath, '/home/someone/.switchboard-dev/launch-token');
});

test('the token file is created 0600 and reused on the next start', () => {
  const dir = tmpDir();
  const tokenPath = path.join(dir, 'nested', 'launch-token');
  const first = ensureLaunchToken(tokenPath);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(ensureLaunchToken(tokenPath), first, 'a restart must not invalidate a caller’s token');
});

test('a token file loosened to 0644 is tightened again', () => {
  const dir = tmpDir();
  const tokenPath = path.join(dir, 'launch-token');
  ensureLaunchToken(tokenPath);
  fs.chmodSync(tokenPath, 0o644);
  ensureLaunchToken(tokenPath);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
});

test('token comparison rejects a wrong token and a wrong type', () => {
  assert.ok(tokensMatch('abc', 'abc'));
  assert.ok(!tokensMatch('abc', 'abd'));
  assert.ok(!tokensMatch('ab', 'abc'), 'a prefix is not a match');
  assert.ok(!tokensMatch(undefined, 'abc'));
  assert.ok(!tokensMatch({ toString: () => 'abc' }, 'abc'));
});

test('a request is rejected without a valid token, before anything else is looked at', () => {
  assert.deepEqual(parseLaunchRequest('{"cwd":"/tmp"}', 'secret'), { ok: false, error: 'bad token' });
  assert.deepEqual(parseLaunchRequest('not json', 'secret'), { ok: false, error: 'malformed JSON' });
  assert.deepEqual(parseLaunchRequest('[1,2]', 'secret'), { ok: false, error: 'request must be an object' });
});

test('cwd must be present and absolute', () => {
  assert.deepEqual(parseLaunchRequest('{"token":"s"}', 's'), { ok: false, error: 'cwd is required' });
  assert.deepEqual(parseLaunchRequest('{"token":"s","cwd":"  "}', 's'), { ok: false, error: 'cwd is required' });
  assert.deepEqual(
    parseLaunchRequest('{"token":"s","cwd":"relative/path"}', 's'),
    { ok: false, error: 'cwd must be an absolute path' },
  );
});

test('a valid request keeps the prompt and defaults autoSubmit to off', () => {
  const ok = parseLaunchRequest('{"token":"s","cwd":"/tmp/./proj","prompt":"continue"}', 's');
  assert.deepEqual(ok, { ok: true, request: { cwd: '/tmp/proj', prompt: 'continue', autoSubmit: false } });
});

test('autoSubmit is honoured only as a real boolean true', () => {
  const on = parseLaunchRequest('{"token":"s","cwd":"/tmp","autoSubmit":true}', 's');
  assert.equal(on.request.autoSubmit, true);
  for (const truthy of ['"yes"', '1', '{}']) {
    const off = parseLaunchRequest(`{"token":"s","cwd":"/tmp","autoSubmit":${truthy}}`, 's');
    assert.equal(off.request.autoSubmit, false, `${truthy} must not enable auto-submit`);
  }
});

test('a missing prompt is empty, not undefined', () => {
  assert.equal(parseLaunchRequest('{"token":"s","cwd":"/tmp"}', 's').request.prompt, '');
  assert.equal(parseLaunchRequest('{"token":"s","cwd":"/tmp","prompt":42}', 's').request.prompt, '');
});

test('a socket file left by a crash is removed; a live one is left alone', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  fs.writeFileSync(socketPath, '');
  assert.equal(await clearStaleSocket(socketPath), true);
  assert.equal(fs.existsSync(socketPath), false);

  const live = net.createServer(s => s.end());
  await new Promise(resolve => live.listen(socketPath, resolve));
  assert.equal(await clearStaleSocket(socketPath), false, 'a live instance keeps its socket');
  assert.equal(fs.existsSync(socketPath), true);
  await new Promise(resolve => live.close(resolve));
});

test('the server hands a valid request to onLaunch and reports its result', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  const seen = [];
  const handle = await startLaunchSocketServer({
    socketPath,
    token: 'secret',
    onLaunch: async req => { seen.push(req); return { ok: true, sessionId: 'abc' }; },
  });

  const reply = await request(socketPath, { token: 'secret', cwd: '/tmp/proj', prompt: 'go', autoSubmit: true });
  assert.deepEqual(reply, { ok: true, sessionId: 'abc' });
  assert.deepEqual(seen, [{ cwd: '/tmp/proj', prompt: 'go', autoSubmit: true }]);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  await handle.close();
  assert.equal(fs.existsSync(socketPath), false, 'close removes the socket file');
});

test('a bad token never reaches onLaunch', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  let called = false;
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: async () => { called = true; return { ok: true }; },
  });

  assert.deepEqual(await request(socketPath, { token: 'guess', cwd: '/tmp' }), { ok: false, error: 'bad token' });
  assert.equal(called, false);
  await handle.close();
});

test('a rejected launch is reported to the caller rather than crashing the server', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  const handle = await startLaunchSocketServer({
    socketPath,
    token: 'secret',
    onLaunch: async req => {
      if (req.cwd === '/unknown') return { ok: false, error: 'not a Switchboard project' };
      throw new Error('boom');
    },
  });

  assert.deepEqual(
    await request(socketPath, { token: 'secret', cwd: '/unknown' }),
    { ok: false, error: 'not a Switchboard project' },
  );
  assert.deepEqual(
    await request(socketPath, { token: 'secret', cwd: '/other' }),
    { ok: false, error: 'boom' },
  );
  await handle.close();
});

test('an oversized request is cut off instead of buffering forever', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: async () => ({ ok: true }),
  });

  const huge = JSON.stringify({ token: 'secret', cwd: '/tmp', prompt: 'x'.repeat(70 * 1024) });
  assert.deepEqual(await request(socketPath, huge), { ok: false, error: 'request too large' });
  await handle.close();
});

test('the server starts over a socket file left by a crash', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  fs.writeFileSync(socketPath, 'stale');
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: async () => ({ ok: true }),
  });
  assert.deepEqual(await request(socketPath, { token: 'secret', cwd: '/tmp' }), { ok: true });
  await handle.close();
});
