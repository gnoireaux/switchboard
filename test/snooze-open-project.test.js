const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const projects = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');

function harness() {
  const rows = new Map();
  const listeners = {};
  const context = vm.createContext({
    attentionSessions: new Set(), responseReadySessions: new Set(),
    sessionBusyState: new Map(), sessionMap: new Map(), sessionEventTimes: new Map(),
    activeSessionId: null, terminalHeaderPtyTitle: null, terminalHeader: { style: {} },
    placeholder: { style: {} },
    projectsUi: { selectedProjectId: null },
    document: { querySelectorAll: selector => rows.get(selector.match(/data-session-id="([^"]+)"/)?.[1]) || [] },
    saveSessionNotices() {}, saveProjectsUi() {}, leaveProjectViews() {}, loadProjects() {},
    bumpSessionEvent() {}, markUnread() {}, setActivity() {}, updateProjectStatusDots() {},
    window: { api: {
      onTerminalNotification: callback => { listeners.notice = callback; },
      onCliBusyState() {},
      updateProject: async () => ({}),
      reportBlockedSessionRowless() {},
    } },
  });
  context.setActiveSession = id => { context.activeSessionId = id; };
  context.projectForSession = session => session?.projectId ? { project: { id: session.projectId } } : null;
  vm.runInContext(projects.slice(projects.indexOf('function dropActiveSession('), projects.indexOf('function selectProject(')), context);
  vm.runInContext(projects.slice(projects.indexOf('async function snoozeProject('), projects.indexOf('function wakeProject(')), context);
  vm.runInContext(app.slice(app.indexOf('window.api.onTerminalNotification('), app.indexOf('// --- Single entry point for all sidebar renders ---')), context);
  const add = (id, projectId) => {
    context.sessionMap.set(id, { sessionId: id, projectId });
    const classes = new Set();
    rows.set(id, [{ classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }]);
    return classes;
  };
  return { state: context, add, listeners };
}

const LATER = new Date(Date.now() + 3600e3).toISOString();

test('snoozing the open project unfocuses its session, so its question badges the row', async () => {
  const { state, add, listeners } = harness();
  const row = add('worker', 'p1');
  state.activeSessionId = 'worker';
  state.projectsUi.selectedProjectId = 'p1';

  await state.snoozeProject({ id: 'p1' }, LATER);
  assert.equal(state.activeSessionId, null, 'the hidden session is no longer the one on screen');

  listeners.notice('worker', 'Claude needs your permission', 'attention');
  assert.ok(state.attentionSessions.has('worker'));
  assert.ok(row.has('needs-attention'));
});

test('snoozing the open project keeps focus on a session of another project', async () => {
  const { state, add } = harness();
  add('elsewhere', 'p2');
  state.activeSessionId = 'elsewhere';
  state.projectsUi.selectedProjectId = 'p1';

  await state.snoozeProject({ id: 'p1' }, LATER);
  assert.equal(state.activeSessionId, 'elsewhere');
});

test('waking a project leaves the focused session alone', async () => {
  const { state, add } = harness();
  add('worker', 'p1');
  state.activeSessionId = 'worker';
  state.projectsUi.selectedProjectId = 'p1';

  await state.snoozeProject({ id: 'p1' }, null);
  assert.equal(state.activeSessionId, 'worker');
  assert.equal(state.projectsUi.selectedProjectId, 'p1', 'the page stays open');
});
