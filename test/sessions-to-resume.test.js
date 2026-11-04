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
  const interruptedByRestartSessions = new Map();
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
    interruptedByRestartSessions,
    setInterruptedByRestart: (id, by) => (by ? interruptedByRestartSessions.set(id, by) : interruptedByRestartSessions.delete(id)),
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

// --- Sessions a quit cuts short: mid-turn or parked on a question ---

test('a session is cut short by a quit when busy or waiting on the user, not when idle', () => {
  const waiting = new Map([['w', 'permission prompt'], ['real-id', 'input needed']]);
  assert.deepEqual(SessionsToResume.interruptionOf('w', live(), waiting), { kind: 'waiting', reason: 'permission prompt' });
  assert.deepEqual(SessionsToResume.interruptionOf('temp', live({ realSessionId: 'real-id' }), waiting),
    { kind: 'waiting', reason: 'input needed' }, 'a re-keyed codex launch is found by its real id');
  assert.deepEqual(SessionsToResume.interruptionOf('b', live({ _cliBusy: true }), waiting), { kind: 'busy' });
  assert.deepEqual(SessionsToResume.interruptionOf('w', live({ _cliBusy: true }), waiting).kind, 'waiting',
    'waiting wins: it names what is lost');
  assert.equal(SessionsToResume.interruptionOf('i', live(), waiting), null);
  assert.equal(SessionsToResume.interruptionOf('b', live({ _cliBusy: true, exited: true }), waiting), null);
  assert.equal(SessionsToResume.interruptionOf('w', live({ isPlainTerminal: true }), waiting), null,
    'a plain terminal is guarded by the Cmd+Q hold only');
  assert.deepEqual(SessionsToResume.interruptionOf('w', live(), { w: 'x' }), { kind: 'waiting', reason: 'x' },
    'reasons as a plain object work too');
});

test('the quit record marks which resumed sessions were cut short', () => {
  const activeSessions = new Map([['idle', live()], ['busy', live({ _cliBusy: true })], ['wait', live()]]);
  const record = SessionsToResume.recordAtQuit({ globalSettings: {}, activeSessions, waitingReasons: new Map([['wait', 'input needed']]) });
  assert.deepEqual(record.sessions.map(s => [s.sessionId, s.interruptedBy || null]), [
    ['idle', null], ['busy', { kind: 'busy' }], ['wait', { kind: 'waiting', reason: 'input needed' }],
  ]);
  assert.ok(!('interruptedBy' in record.sessions[0]), 'an idle session stores no interruptedBy key');
});

test('quit warning lists each cut-short session with what it was doing', () => {
  const interrupted = SessionsToResume.sessionsInterruptedByQuit(
    new Map([['aaaaaaaa-1', live({ _cliBusy: true })], ['bbbbbbbb-2', live()], ['cccccccc-3', live()]]),
    new Map([['cccccccc-3', 'permission prompt']]),
  );
  assert.deepEqual(SessionsToResume.quitWarningLines(interrupted), ['• aaaaaaaa (working)', '• cccccccc (waiting: permission prompt)']);
  assert.deepEqual(SessionsToResume.quitWarningLines(interrupted.slice(0, 1), e => `T ${e.projectPath}`), ['• T /work/repo (working)']);
  assert.match(SessionsToResume.interruptedTooltip({ kind: 'waiting', reason: 'permission prompt' }), /waiting on you \(permission prompt\).*question is gone/);
  assert.match(SessionsToResume.interruptedTooltip({ kind: 'busy' }), /turn was stopped/);
});

function quitGuardHarness({ activeSessions, waiting = {}, answer = 1, globalSettings = {}, meta = {}, cached = {} }) {
  const dialogs = [];
  const context = vm.createContext({
    sessionsToResume: SessionsToResume, path, Map, Object,
    activeSessions,
    sessionStates: { snapshot: () => Object.fromEntries(Object.entries(waiting).map(([id, why]) => [id, { waitingFor: why }])) },
    getSetting: key => (key === 'global' ? globalSettings : null),
    getMeta: id => meta[id] || null,
    getCachedSession: id => cached[id] || null,
    mainWindow: { isDestroyed: () => false },
    log: { info: () => {} },
    dialog: { showMessageBoxSync: (_parent, options) => { dialogs.push(options); return answer; } },
  });
  const src = main.slice(main.indexOf('let quitConfirmed = false;'), main.indexOf('function hasRunningSessions('));
  vm.runInContext(src.replace('let quitConfirmed', 'var quitConfirmed'), context);
  return { context, dialogs };
}

test('quitting asks first when a session is working or waiting, and only once', () => {
  const activeSessions = new Map([['s1', live({ _cliBusy: true, projectPath: '/work/alpha' })], ['s2', live()]]);
  const cancelled = quitGuardHarness({ activeSessions, answer: 0, meta: { s1: { name: 'Fix the parser' } } });
  assert.equal(cancelled.context.confirmQuitInterruptingSessions(), false, 'Cancel keeps the app running');
  assert.equal(cancelled.dialogs.length, 1);
  assert.match(cancelled.dialogs[0].message, /^1 session is working or waiting on you$/);
  assert.match(cancelled.dialogs[0].detail, /resumed at the next launch, but idle/);
  assert.match(cancelled.dialogs[0].detail, /• Fix the parser — alpha \(working\)/);
  assert.deepEqual([...cancelled.dialogs[0].buttons], ['Cancel', 'Quit Anyway']);
  assert.equal(cancelled.dialogs[0].cancelId, 0);
  assert.equal(cancelled.context.confirmQuitInterruptingSessions(), false, 'asked again after a Cancel');
  assert.equal(cancelled.dialogs.length, 2);

  const agreed = quitGuardHarness({ activeSessions, waiting: { s2: 'permission prompt' }, cached: { s2: { aiTitle: 'Deploy  the\nthing' } } });
  assert.equal(agreed.context.confirmQuitInterruptingSessions(), true);
  assert.match(agreed.dialogs[0].message, /^2 sessions/);
  assert.match(agreed.dialogs[0].detail, /• Deploy the thing — repo \(waiting: permission prompt\)/);
  assert.equal(agreed.context.confirmQuitInterruptingSessions(), true);
  assert.equal(agreed.dialogs.length, 1, 'the quit that follows Quit Anyway does not ask again');
});

test('quitting with only idle sessions, or none, asks nothing; with resume off the dialog says they stay stopped', () => {
  const idle = quitGuardHarness({ activeSessions: new Map([['s1', live()]]) });
  assert.equal(idle.context.confirmQuitInterruptingSessions(), true);
  assert.equal(idle.dialogs.length, 0);
  const off = quitGuardHarness({ activeSessions: new Map([['s1', live({ _cliBusy: true })]]), globalSettings: { resumeSessionsAfterRestart: false } });
  off.context.confirmQuitInterruptingSessions();
  assert.match(off.dialogs[0].detail, /^Quitting stops them mid-way\./);
});

test('every quit path goes through the guard: before-quit first thing, the new-build restart before arming relaunch', () => {
  const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"));
  const guard = quit.indexOf('if (!confirmQuitInterruptingSessions()) {');
  assert.ok(guard > 0 && guard < quit.indexOf('appIsQuitting = true'), 'asked before any shutdown step');
  assert.match(quit.slice(guard, guard + 120), /event\.preventDefault\(\);\s*return;/);
  assert.match(quit, /recordAtQuit\(\{[^}]*waitingReasons: waitingReasonsNow\(\)/);
  const relaunch = main.slice(main.indexOf("ipcMain.handle('relaunch-for-installed-build'"));
  const body = relaunch.slice(0, relaunch.indexOf('});'));
  assert.match(body, /if \(!confirmQuitInterruptingSessions\(\)\) return [^\n]*\n\s*app\.relaunch\(\);/);
});

test('startup marks the resumed sessions that were cut short, and the status says how many', async () => {
  const { context, statuses } = rendererHarness({
    stored: { sessions: [
      { sessionId: 'a', projectPath: '/r', interruptedBy: { kind: 'busy' } },
      { sessionId: 'b', projectPath: '/r' },
      { sessionId: 'c', projectPath: '/r', interruptedBy: { kind: 'waiting', reason: 'input needed' } },
    ] },
    failing: ['c'],
  });
  await context.resumeSessionsRunningAtQuit();
  assert.deepEqual([...context.interruptedByRestartSessions.keys()], ['a'], 'a session that failed to start is not marked');
  assert.match(statuses[0].text, /Resumed 2 sessions from before the restart \(1 interrupted/);
});

test('the interrupted chip is in every session row and cleared by typing into the terminal', () => {
  const sidebar = fs.readFileSync(path.join(__dirname, '../public/sidebar.js'), 'utf8');
  const projectsView = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
  const terminalManager = fs.readFileSync(path.join(__dirname, '../public/terminal-manager.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(sidebar, /session-state-chip session-interrupted-chip/);
  assert.match(projectsView, /session-state-chip session-interrupted-chip/);
  assert.match(css, /\.interrupted-by-restart \.session-interrupted-chip/);
  const onData = terminalManager.slice(terminalManager.indexOf('terminal.onData('));
  assert.match(onData.slice(0, onData.indexOf('});')), /data\[0\] !== '\\x1b' && typeof setInterruptedByRestart === 'function'\) setInterruptedByRestart\(entry\.session\.sessionId, null\)/);
});

test('the row state classes show the interrupted chip with its tooltip, and drop it once cleared', () => {
  const start = app.indexOf('const interruptedByRestartSessions');
  const src = app.slice(start, app.indexOf('window.api.onSessionStates('));
  const classes = new Set();
  const chip = { title: '' };
  const item = {
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    querySelector: sel => (sel === '.session-interrupted-chip' ? chip : null),
  };
  const context = vm.createContext({
    Map, Set, SessionsToResume, waitingSessions: new Map(), scrolledUpSessions: new Set(),
    forEachSessionItem: (_id, fn) => fn(item),
  });
  vm.runInContext(src.replace('const interruptedByRestartSessions', 'var interruptedByRestartSessions'), context);
  context.setInterruptedByRestart('a', { kind: 'busy' });
  assert.ok(classes.has('interrupted-by-restart'));
  assert.match(chip.title, /turn was stopped/);
  context.setInterruptedByRestart('a', null);
  assert.ok(!classes.has('interrupted-by-restart'));
  assert.equal(chip.title, '');
});
