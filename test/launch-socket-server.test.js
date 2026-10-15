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
  assert.deepEqual(ok, { ok: true, request: { type: 'launch', cwd: '/tmp/proj', prompt: 'continue', autoSubmit: false, inheritFrom: null, options: null } });
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

test('inheritFrom passes through as a session id, and anything else is refused', () => {
  const sid = '1e4fc13c-c629-429d-b21c-eec2d71b907c';
  assert.equal(parseLaunchRequest(`{"token":"s","cwd":"/tmp","inheritFrom":"${sid}"}`, 's').request.inheritFrom, sid);
  assert.equal(parseLaunchRequest('{"token":"s","cwd":"/tmp","inheritFrom":null}', 's').request.inheritFrom, null);
  for (const bad of ['42', '""', '"a b"', '"../x"', '{}', `"${'a'.repeat(129)}"`]) {
    assert.deepEqual(
      parseLaunchRequest(`{"token":"s","cwd":"/tmp","inheritFrom":${bad}}`, 's'),
      { ok: false, error: 'inheritFrom must be a session id' },
      `${bad} must be refused`,
    );
  }
});

test('options pass through as an object, and anything else is refused', () => {
  const opts = { effort: 'xhigh', model: 'opus' };
  assert.deepEqual(parseLaunchRequest(`{"token":"s","cwd":"/tmp","options":${JSON.stringify(opts)}}`, 's').request.options, opts);
  assert.equal(parseLaunchRequest('{"token":"s","cwd":"/tmp","options":null}', 's').request.options, null);
  for (const bad of ['"xhigh"', '42', '[]', 'true']) {
    assert.deepEqual(
      parseLaunchRequest(`{"token":"s","cwd":"/tmp","options":${bad}}`, 's'),
      { ok: false, error: 'options must be an object' },
      `${bad} must be refused`,
    );
  }
});

test('the client sends the caller\u2019s session id unless told otherwise', () => {
  const { parseArgs } = require('../scripts/launch-session');
  const env = { CLAUDE_CODE_SESSION_ID: 'caller-sid' };
  assert.equal(parseArgs(['--cwd', '/p'], env).inheritFrom, 'caller-sid');
  assert.equal(parseArgs(['--cwd', '/p'], {}).inheritFrom, null, 'outside Claude Code there is nothing to inherit');
  assert.equal(parseArgs(['--inherit-from', 'other-sid'], env).inheritFrom, 'other-sid');
  assert.equal(parseArgs(['--no-inherit'], env).inheritFrom, null);
  assert.equal(parseArgs(['--no-inherit', '--inherit-from', 'x'], env).inheritFrom, 'x', 'the last flag wins');
});

test('the client collects requested session settings from its flags', () => {
  const { parseArgs } = require('../scripts/launch-session');
  assert.deepEqual(parseArgs(['--cwd', '/p'], {}).options, {}, 'no flag, no settings');
  assert.deepEqual(
    parseArgs(['--effort', 'xhigh', '--model', 'opus[1m]', '--permission-mode', 'auto', '--option', 'appendSystemPrompt=a=b'], {}).options,
    { effort: 'xhigh', model: 'opus[1m]', permissionMode: 'auto', appendSystemPrompt: 'a=b' },
    '--option splits on the first = only',
  );
  assert.deepEqual(parseArgs(['--effort', ''], {}).options, { effort: '' }, 'an empty value asks for the CLI default');
  assert.deepEqual(parseArgs(['--effort', 'low', '--option', 'effort=max'], {}).options, { effort: 'max' }, 'the last flag wins');
  assert.equal(parseArgs(['--features'], {}).features, true);
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

test('a features request names what launches apply, and launches nothing', async () => {
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"features"}', 's'), { ok: true, request: { type: 'features' } });
  assert.deepEqual(parseLaunchRequest('{"token":"x","type":"features"}', 's'), { ok: false, error: 'bad token' });
  const socketPath = path.join(tmpDir(), 'launch.sock');
  const launched = [];
  const handle = await startLaunchSocketServer({ socketPath, token: 'secret', onLaunch: req => { launched.push(req); return { ok: true }; } });
  assert.deepEqual(await request(socketPath, { token: 'secret', type: 'features' }), { ok: true, features: ['options'] });
  assert.deepEqual(launched, []);
  await handle.close();
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
  assert.deepEqual(seen, [{ type: 'launch', cwd: '/tmp/proj', prompt: 'go', autoSubmit: true, inheritFrom: null, options: null }]);
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

test('a session-states request needs the token but no cwd, and an unknown type is refused', () => {
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"session-states"}', 's'),
    { ok: true, request: { type: 'session-states' } });
  assert.deepEqual(parseLaunchRequest('{"token":"x","type":"session-states"}', 's'),
    { ok: false, error: 'bad token' });
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"rm-rf","cwd":"/tmp"}', 's'),
    { ok: false, error: 'unknown request type' });
  assert.equal(parseLaunchRequest('{"token":"s","type":"launch","cwd":"/tmp"}', 's').request.type, 'launch');
});

test('the server answers session-states from onSessionStates without launching anything', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  let launched = false;
  const sessions = { abc: { waitingFor: 'input needed' }, def: { scrolledUp: true } };
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret',
    onLaunch: async () => { launched = true; return { ok: true }; },
    onSessionStates: () => ({ ok: true, sessions }),
  });

  assert.deepEqual(await request(socketPath, { token: 'secret', type: 'session-states' }), { ok: true, sessions });
  assert.equal(launched, false);
  await handle.close();
});

test('a server started without onSessionStates says so instead of launching', async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, 'launch.sock');
  let launched = false;
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: async () => { launched = true; return { ok: true }; },
  });

  assert.deepEqual(await request(socketPath, { token: 'secret', type: 'session-states' }),
    { ok: false, error: 'session states not available' });
  assert.equal(launched, false);
  await handle.close();
});
