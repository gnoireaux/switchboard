const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const {
  defaultLaunchPaths, ensureLaunchToken, tokensMatch, parseLaunchRequest,
  clearStaleSocket, startLaunchSocketServer, PROJECT_OPS,
  bundledLaunchClientPath, removeLaunchClientPointer,
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
  const paths = defaultLaunchPaths('/home/someone', null);
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
  assert.deepEqual(await request(socketPath, { token: 'secret', type: 'features' }), {
    ok: true, features: ['options', 'manual-mode', 'project-ops'], projectOps: PROJECT_OPS,
  });
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

test('the client gives up on a Switchboard that accepts but never answers', async () => {
  const { askSwitchboard } = require('../scripts/launch-session');
  const socketPath = path.join(tmpDir(), 'silent.sock');
  const held = [];
  const silent = net.createServer(conn => held.push(conn));
  await new Promise(resolve => silent.listen(socketPath, resolve));
  try {
    await assert.rejects(askSwitchboard(socketPath, { type: 'features' }, 100), /no reply from Switchboard .* within 0.1s/);
  } finally {
    // close() waits for open connections, and this server never ends its own.
    for (const conn of held) conn.destroy();
    await new Promise(resolve => silent.close(resolve));
  }
});

test('the client returns the reply of a Switchboard that answers', async () => {
  const { askSwitchboard } = require('../scripts/launch-session');
  const socketPath = path.join(tmpDir(), 'launch.sock');
  const handle = await startLaunchSocketServer({ socketPath, token: 'secret', onLaunch: () => ({ ok: true }) });
  try {
    assert.deepEqual((await askSwitchboard(socketPath, { token: 'secret', type: 'features' }, 1000)).features, ['options', 'manual-mode', 'project-ops']);
    await assert.rejects(askSwitchboard(path.join(tmpDir(), 'none.sock'), {}, 1000), /cannot reach Switchboard/);
  } finally {
    await handle.close();
  }
});

test('a project-op request names a known op and passes its args as an object', () => {
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"project-op","op":"project.update","args":{"projectId":"p","name":"N"}}', 's'),
    { ok: true, request: { type: 'project-op', op: 'project.update', args: { projectId: 'p', name: 'N' } } });
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"project-op","op":"projects"}', 's'),
    { ok: true, request: { type: 'project-op', op: 'projects', args: {} } }, 'missing args are an empty object');
  assert.deepEqual(parseLaunchRequest('{"token":"x","type":"project-op","op":"projects"}', 's'), { ok: false, error: 'bad token' });
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"project-op","op":"project.delete","args":{}}', 's'),
    { ok: false, error: 'unknown project op: project.delete' });
  assert.deepEqual(parseLaunchRequest('{"token":"s","type":"project-op","op":"projects","args":[1]}', 's'),
    { ok: false, error: 'args must be an object' });
});

test('no project op deletes anything', () => {
  assert.deepEqual(PROJECT_OPS.filter(op => /delete|remove/i.test(op)), []);
});

test('the server hands a project op to onProjectOp, never to onLaunch, and reports a refusal as not ok', async () => {
  const socketPath = path.join(tmpDir(), 'launch.sock');
  const calls = [];
  let launched = false;
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret',
    onLaunch: () => { launched = true; return { ok: true }; },
    onProjectOp: async (op, args) => {
      calls.push([op, args]);
      return args.projectId === 'gone' ? { error: 'Project not found' } : { project: { id: args.projectId } };
    },
  });
  try {
    assert.deepEqual(await request(socketPath, { token: 'secret', type: 'project-op', op: 'project.update', args: { projectId: 'p1', name: 'N' } }),
      { ok: true, project: { id: 'p1' } });
    assert.deepEqual(await request(socketPath, { token: 'secret', type: 'project-op', op: 'project.update', args: { projectId: 'gone' } }),
      { ok: false, error: 'Project not found' });
    assert.deepEqual(calls, [['project.update', { projectId: 'p1', name: 'N' }], ['project.update', { projectId: 'gone' }]]);
    assert.equal(launched, false);
  } finally {
    await handle.close();
  }
});

test('a project op that throws is reported, and the server keeps answering', async () => {
  const socketPath = path.join(tmpDir(), 'launch.sock');
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: () => ({ ok: true }),
    onProjectOp: () => { throw new Error('db locked'); },
  });
  try {
    assert.deepEqual(await request(socketPath, { token: 'secret', type: 'project-op', op: 'projects' }), { ok: false, error: 'db locked' });
    assert.equal((await request(socketPath, { token: 'secret', type: 'features' })).ok, true);
  } finally {
    await handle.close();
  }
});

test('a server started without onProjectOp says so', async () => {
  const socketPath = path.join(tmpDir(), 'launch.sock');
  const handle = await startLaunchSocketServer({ socketPath, token: 'secret', onLaunch: () => ({ ok: true }) });
  try {
    assert.deepEqual(await request(socketPath, { token: 'secret', type: 'project-op', op: 'projects' }),
      { ok: false, error: 'project ops not available' });
  } finally {
    await handle.close();
  }
});

// Runs scripts/project-op.js against the instance whose data dir is dataDir.
function runProjectOpClient(dataDir, argv) {
  const { execFile } = require('child_process');
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'project-op.js'), ...argv],
      { env: { ...process.env, SWITCHBOARD_DATA_DIR: dataDir } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('the project-op client prints the reply of a Switchboard that applies the op', async () => {
  const dataDir = tmpDir();
  const { socketPath, tokenPath } = defaultLaunchPaths(os.homedir(), dataDir);
  const token = ensureLaunchToken(tokenPath);
  const handle = await startLaunchSocketServer({
    socketPath, token, onLaunch: () => ({ ok: true }),
    onProjectOp: (op, args) => ({ op, args }),
  });
  try {
    const done = await runProjectOpClient(dataDir, ['track.create', '{"projectId":"p","name":"T"}']);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), { ok: true, op: 'track.create', args: { projectId: 'p', name: 'T' } });
    const refused = await runProjectOpClient(dataDir, ['project.delete', '{}']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /unknown project op: project\.delete/);
    const badArgs = await runProjectOpClient(dataDir, ['projects', '[1]']);
    assert.equal(badArgs.code, 2);
  } finally {
    await handle.close();
  }
});

test('the project-op client exits 3 on a Switchboard that predates project ops', async () => {
  const dataDir = tmpDir();
  const { socketPath, tokenPath } = defaultLaunchPaths(os.homedir(), dataDir);
  ensureLaunchToken(tokenPath);
  const held = [];
  const old = net.createServer(conn => {
    held.push(conn);
    conn.end(`${JSON.stringify({ ok: false, error: 'unknown request type' })}\n`);
  });
  await new Promise(resolve => old.listen(socketPath, resolve));
  try {
    const result = await runProjectOpClient(dataDir, ['projects']);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /predates project ops/);
  } finally {
    for (const conn of held) conn.destroy();
    await new Promise(resolve => old.close(resolve));
  }
});

test('the launch-client pointer sits next to the socket, in the instance\u2019s own data dir', () => {
  assert.equal(defaultLaunchPaths('/home/someone', null).launchClientPointerPath, '/home/someone/.switchboard/launch-client');
  assert.equal(defaultLaunchPaths('/home/someone', '/home/someone/.switchboard-alt').launchClientPointerPath,
    '/home/someone/.switchboard-alt/launch-client');
});

test('the bundled client is the checkout\u2019s script, or the unpacked copy in a packaged app', () => {
  assert.equal(bundledLaunchClientPath({ appRoot: '/src/switchboard' }), '/src/switchboard/scripts/launch-session.js');
  assert.equal(
    bundledLaunchClientPath({ appRoot: '/A.app/Contents/Resources/app.asar', isPackaged: true, resourcesPath: '/A.app/Contents/Resources' }),
    '/A.app/Contents/Resources/app.asar.unpacked/scripts/launch-session.js',
    'plain node cannot read inside app.asar');
});

test('a listening server publishes its client path, and withdraws it on close', async () => {
  const dataDir = tmpDir();
  const { socketPath, launchClientPointerPath } = defaultLaunchPaths(os.homedir(), dataDir);
  const clientPath = '/Apps/Switchboard.app/Contents/Resources/app.asar.unpacked/scripts/launch-session.js';
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: () => ({ ok: true }),
    launchClient: { pointerPath: launchClientPointerPath, clientPath },
  });
  assert.equal(fs.readFileSync(launchClientPointerPath, 'utf8'), `${clientPath}\n`);
  assert.equal(fs.statSync(launchClientPointerPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['launch-client', 'launch.sock'], 'no temporary file is left behind');
  await handle.close();
  assert.equal(fs.existsSync(launchClientPointerPath), false);
});

test('closing leaves a pointer that another instance rewrote since', async () => {
  const dataDir = tmpDir();
  const { socketPath, launchClientPointerPath } = defaultLaunchPaths(os.homedir(), dataDir);
  const handle = await startLaunchSocketServer({
    socketPath, token: 'secret', onLaunch: () => ({ ok: true }),
    launchClient: { pointerPath: launchClientPointerPath, clientPath: '/old/scripts/launch-session.js' },
  });
  fs.writeFileSync(launchClientPointerPath, '/new/scripts/launch-session.js\n');
  await handle.close();
  assert.equal(fs.readFileSync(launchClientPointerPath, 'utf8'), '/new/scripts/launch-session.js\n');
  assert.equal(removeLaunchClientPointer(path.join(dataDir, 'missing'), '/x'), false, 'a missing pointer is not an error');
});

test('a server that cannot listen publishes no client path', async () => {
  const dataDir = tmpDir();
  const { socketPath, launchClientPointerPath } = defaultLaunchPaths(os.homedir(), dataDir);
  const live = net.createServer(s => s.end());
  await new Promise(resolve => live.listen(socketPath, resolve));
  try {
    await assert.rejects(startLaunchSocketServer({
      socketPath, token: 'secret', onLaunch: () => ({ ok: true }),
      launchClient: { pointerPath: launchClientPointerPath, clientPath: '/second/scripts/launch-session.js' },
    }));
    assert.equal(fs.existsSync(launchClientPointerPath), false);
  } finally {
    await new Promise(resolve => live.close(resolve));
  }
});

test('the client runs from an unpacked app layout, where its require resolves outside app.asar', async () => {
  const { execFile } = require('child_process');
  const unpacked = path.join(tmpDir(), 'app.asar.unpacked');
  fs.mkdirSync(path.join(unpacked, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'launch-socket-server.js'), path.join(unpacked, 'launch-socket-server.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'launch-session.js'), path.join(unpacked, 'scripts', 'launch-session.js'));
  const dataDir = tmpDir();
  const { socketPath, tokenPath } = defaultLaunchPaths(os.homedir(), dataDir);
  const handle = await startLaunchSocketServer({ socketPath, token: ensureLaunchToken(tokenPath), onLaunch: () => ({ ok: true }) });
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, [path.join(unpacked, 'scripts', 'launch-session.js'), '--features'],
        { env: { ...process.env, SWITCHBOARD_DATA_DIR: dataDir } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['options', 'manual-mode', 'project-ops']);
  } finally {
    await handle.close();
  }
});
