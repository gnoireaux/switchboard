const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SessionsToResume = require('../public/sessions-to-resume');

function live(overrides = {}) {
  return {
    isPlainTerminal: false, exited: false, pendingLaunch: null,
    projectPath: '/work/repo', runtime: 'claude', projectId: null, trackId: null,
    launchOptions: { runtime: 'claude', permissionMode: 'auto' },
    ...overrides,
  };
}

test('quit records the running CLI sessions, not terminals, ended ones or unresolved launches', () => {
  const activeSessions = new Map([
    ['claude-a', live({ projectId: 'p1', trackId: 't1' })],
    ['codex-b', live({ runtime: 'codex', launchOptions: { runtime: 'codex', codexModel: 'gpt' } })],
    ['shell', live({ isPlainTerminal: true, runtime: null, launchOptions: null })],
    ['ended', live({ exited: true })],
    ['codex-temp-id', live({ runtime: 'codex', pendingLaunch: { tag: 'x' } })],
  ]);
  const record = SessionsToResume.recordAtQuit({ globalSettings: {}, activeSessions, now: 42 });
  assert.equal(record.savedAt, 42);
  assert.deepEqual(record.sessions.map(s => s.sessionId), ['claude-a', 'codex-b']);
  assert.deepEqual(record.sessions[0], {
    sessionId: 'claude-a', projectPath: '/work/repo', runtime: 'claude', projectId: 'p1', trackId: 't1',
    launchOptions: { runtime: 'claude', permissionMode: 'auto' },
  });
});

test('quit records nothing when the setting is off or no CLI session runs', () => {
  const activeSessions = new Map([['claude-a', live()]]);
  assert.equal(SessionsToResume.recordAtQuit({ globalSettings: { resumeSessionsAfterRestart: false }, activeSessions }), null);
  assert.equal(SessionsToResume.recordAtQuit({ globalSettings: null, activeSessions: new Map() }), null);
  assert.ok(SessionsToResume.recordAtQuit({ globalSettings: null, activeSessions }), 'no global settings yet means on');
});

test('launch reopens recorded sessions unless already open, archived, duplicated or turned off since', () => {
  const stored = {
    savedAt: 1,
    sessions: [
      { sessionId: 'a', projectPath: '/r' },
      { sessionId: 'open', projectPath: '/r' },
      { sessionId: 'archived', projectPath: '/r' },
      { sessionId: 'a', projectPath: '/r' },
      { sessionId: 'no-path' },
      { sessionId: 'unknown', projectPath: '/r' },
    ],
  };
  const rows = { a: { sessionId: 'a' }, archived: { sessionId: 'archived', archived: 1 } };
  const out = SessionsToResume.sessionsToReopen(stored, {
    globalSettings: {},
    isOpen: id => id === 'open',
    lookup: id => rows[id] || null,
  });
  assert.deepEqual(out.map(({ saved, row }) => [saved.sessionId, row?.sessionId ?? null]), [['a', 'a'], ['unknown', null]]);
  assert.deepEqual(SessionsToResume.sessionsToReopen(stored, { globalSettings: { resumeSessionsAfterRestart: false } }), []);
  assert.deepEqual(SessionsToResume.sessionsToReopen(null), []);
});

test('a resumed session keeps the options it ran with over the current defaults', () => {
  const options = SessionsToResume.resumeOptions(
    { permissionMode: null, model: '', effort: 'high' },
    { runtime: 'claude', launchOptions: { runtime: 'claude', permissionMode: 'auto', model: 'opus' } },
    { runtime: 'claude' },
  );
  assert.deepEqual(options, { permissionMode: 'auto', model: 'opus', effort: 'high', runtime: 'claude' });
  assert.equal(SessionsToResume.resumeOptions({}, { runtime: 'codex' }, null).runtime, 'codex',
    'without a row the recorded runtime decides');
});

// --- Wiring ---

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

test('main records the sessions at before-quit before killing their PTYs, and hands the list out once', () => {
  const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"));
  const record = quit.indexOf('sessionsToResume.recordAtQuit(');
  assert.ok(record > 0, 'before-quit records');
  assert.ok(record < quit.indexOf('session.pty.kill()'), 'recorded before the kills mark sessions exited');
  const take = main.slice(main.indexOf("ipcMain.handle('take-sessions-to-resume'"));
  assert.match(take.slice(0, take.indexOf('});')), /deleteSetting\(sessionsToResume\.SETTING_KEY\)/);
});

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function rendererHarness({ stored, globalSettings = {}, rows = [], open = [], failing = [] }) {
  const opened = [];
  const statuses = [];
  const sessionMap = new Map(rows.map(r => [r.sessionId, r]));
  const context = vm.createContext({
    SessionsToResume,
    Promise, Date, Map, Set,
    window: { api: {
      takeSessionsToResume: async () => stored,
      getSetting: async key => (key === 'global' ? globalSettings : null),
    } },
    openSessions: new Map(open.map(id => [id, {}])),
    sessionMap,
    pendingSessions: new Map(),
    cachedProjects: [],
    cachedAllProjects: [],
    encodeProjectPath: p => p.replace(/\//g, '-'),
    injectPendingIntoTree: () => {},
    refreshSidebar: () => {},
    pollActiveSessions: async () => {},
    resolveDefaultSessionOptions: async () => ({ permissionMode: null, effort: 'high' }),
    openSession: async (session, options, flags) => {
      opened.push({ session, options, flags });
      return !failing.includes(session.sessionId);
    },
    setUpdaterStatus: (text, duration) => statuses.push({ text, duration }),
  });
  vm.runInContext(app.slice(app.indexOf('function injectResumedSessionRow('), app.indexOf('// Handle window resize')), context);
  return { context, opened, statuses, sessionMap };
}

test('startup resumes each recorded session hidden, with its own options, and says how many', async () => {
  const { context, opened, statuses, sessionMap } = rendererHarness({
    stored: { sessions: [
      { sessionId: 'a', projectPath: '/r', runtime: 'claude', launchOptions: { runtime: 'claude', permissionMode: 'auto' } },
      { sessionId: 'b', projectPath: '/s', runtime: 'claude', projectId: 'p1', trackId: 't1' },
      { sessionId: 'c', projectPath: '/r', runtime: 'claude' },
    ] },
    rows: [{ sessionId: 'a', projectPath: '/r', runtime: 'claude' }],
    open: ['c'],
  });
  await context.resumeSessionsRunningAtQuit();
  assert.deepEqual(opened.map(o => o.session.sessionId), ['a', 'b'], 'an already open session is left alone');
  assert.ok(opened.every(o => o.flags.show === false), 'resumed in the background');
  assert.equal(opened[0].session, sessionMap.get('a'), 'a known session resumes through its own row');
  assert.deepEqual({ ...opened[0].options }, { permissionMode: 'auto', effort: 'high', runtime: 'claude' });
  const injected = opened[1].session;
  assert.equal(sessionMap.get('b'), injected, 'a session the lists lack gets a row');
  assert.equal(injected.projectId, 'p1');
  assert.ok(context.pendingSessions.has('b'));
  assert.equal(context.cachedProjects[0].projectPath, '/s');
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].text, /Resumed 2 sessions/);
});

test('startup resumes nothing, and says nothing, without a record or with the setting off', async () => {
  for (const setup of [
    { stored: null },
    { stored: { sessions: [{ sessionId: 'a', projectPath: '/r' }] }, globalSettings: { resumeSessionsAfterRestart: false } },
  ]) {
    const { context, opened, statuses } = rendererHarness(setup);
    await context.resumeSessionsRunningAtQuit();
    assert.equal(opened.length, 0);
    assert.equal(statuses.length, 0);
  }
});

test('the count leaves out sessions that failed to start', async () => {
  const { context, statuses } = rendererHarness({
    stored: { sessions: [{ sessionId: 'a', projectPath: '/r' }, { sessionId: 'b', projectPath: '/r' }] },
    failing: ['b'],
  });
  await context.resumeSessionsRunningAtQuit();
  assert.match(statuses[0].text, /Resumed 1 session from/);
});
