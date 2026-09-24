// Turns `claude agents --json` output into edge-triggered "needs attention"
// notifications for Claude sessions that Switchboard is NOT hosting a PTY for.
//
// Sessions running inside Switchboard already signal attention through the
// OSC 9 sequences their PTY emits (see main.js). Sessions started elsewhere
// (another terminal, a background agent) emit those sequences into a terminal
// we never see, so the only way to notice them is to poll the CLI.
//
// Shapes observed in `claude agents --json` (verified 2026-09-22):
//   background: { id, sessionId, cwd, kind, name, state: 'blocked'|'working'|'done',
//                 status?: 'waiting'|'idle'|'busy', waitingFor?, pid? }
//   interactive: { pid, sessionId, cwd, kind, name, status: 'waiting'|'idle'|'busy',
//                  waitingFor? }
// `state` only exists on background agents, so an interactive session waiting on
// a permission prompt is detected through `status`/`waitingFor` instead.

const AGENT_POLL_INTERVAL_MS = 10000;

const WAITING_FOR_PERMISSION = 'permission prompt';
const WAITING_FOR_INPUT = 'input needed';
// A background agent whose turn ended cleanly reports `state: 'done'`. One whose
// turn ended on a question in its reply, or on an error such as a spend limit,
// reports `state: 'blocked'` with no `waitingFor` (observed 2026-09-24): it
// needs the human, but through its reply, not a prompt still on screen.
const AWAITING_REPLY = 'awaiting reply';

// Reason strings are the stable identity of "why this session needs attention".
// A change of reason (input needed → permission prompt) re-triggers a
// notification; an unchanged reason stays silent however long it lasts.
function attentionReasonForAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const isBlocked = agent.state === 'blocked' || agent.status === 'waiting';
  if (!isBlocked) return null;
  if (typeof agent.waitingFor === 'string' && agent.waitingFor) return agent.waitingFor;
  if (agent.state === 'blocked' && agent.status !== 'waiting') return AWAITING_REPLY;
  return 'blocked';
}

// Phrased like the Claude CLI's own notifications, since the text is shown in
// the terminal header. The badge does not depend on it: main sends these with
// kind 'attention' (see pollBlockedAgents in main.js).
function notificationMessageForReason(reason) {
  if (reason === WAITING_FOR_PERMISSION) return 'Claude needs your permission to continue';
  if (reason === WAITING_FOR_INPUT) return 'Claude Code needs your attention — input needed';
  if (reason === AWAITING_REPLY) return 'Claude Code needs your attention — awaiting your reply';
  return 'Claude Code needs your attention';
}

// Text for the native OS notification raised when the renderer has no sidebar
// row to badge (session archived, filtered out, or in a folder not indexed).
// The cwd is what identifies such a session, so it goes in the body in full.
function nativeNotificationForAgent({ reason, name, cwd, homeDir }) {
  const title = reason === WAITING_FOR_PERMISSION ? 'Claude needs your permission'
    : reason === WAITING_FOR_INPUT ? 'Claude needs your input'
    : reason === AWAITING_REPLY ? 'Claude is waiting for your reply'
    : 'Claude session is blocked';
  let where = typeof cwd === 'string' && cwd ? cwd : null;
  if (where && homeDir && (where === homeDir || where.startsWith(homeDir + '/'))) {
    where = '~' + where.slice(homeDir.length);
  }
  const body = [typeof name === 'string' && name ? name : null, where].filter(Boolean).join('\n');
  return { title, body: body || 'Session outside the sidebar' };
}

// Pure diff step: given this tick's agent list, which sessions Switchboard hosts,
// and the reasons recorded last tick, return the notifications to raise now and
// the reasons to remember for the next tick.
//
// Hosted sessions are tracked but never notified — their reason is remembered so
// that closing their terminal in Switchboard doesn't fire a stale notification.
//
// A turn that ended awaiting a reply is announced only when this poller saw the
// agent working the tick before. Such agents linger in the list for weeks, so
// without that every app start would re-announce all of them; the price is that
// a turn which ends while Switchboard is closed goes unannounced.
function computeBlockedAgentNotifications({ agents, hostedSessionIds, previousReasons, previousWorkingSessionIds }) {
  const hosted = hostedSessionIds instanceof Set ? hostedSessionIds : new Set(hostedSessionIds || []);
  const previous = previousReasons instanceof Map ? previousReasons : new Map();
  const previousWorking = previousWorkingSessionIds instanceof Set
    ? previousWorkingSessionIds
    : new Set(previousWorkingSessionIds || []);
  const reasons = new Map();
  const workingSessionIds = new Set();
  const notifications = [];

  for (const agent of Array.isArray(agents) ? agents : []) {
    const sessionId = agent && agent.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) continue;
    if (agent.state === 'working') workingSessionIds.add(sessionId);
    const reason = attentionReasonForAgent(agent);
    if (!reason) continue;

    reasons.set(sessionId, reason);
    if (hosted.has(sessionId)) continue;
    if (previous.get(sessionId) === reason) continue;
    if (reason === AWAITING_REPLY && !previousWorking.has(sessionId)) continue;

    notifications.push({
      sessionId,
      reason,
      message: notificationMessageForReason(reason),
      cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
      name: typeof agent.name === 'string' ? agent.name : null,
    });
  }

  return { notifications, reasons, workingSessionIds };
}

// Background agents whose process is still alive, keyed by session id, valued by
// the short agent id. `claude --resume` refuses such a session while it runs
// ("is running as a background session … Run `claude attach`"), so opening it
// from the sidebar must attach instead.
function liveBackgroundAgentIds(agents) {
  const ids = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || agent.kind !== 'background' || !agent.pid) continue;
    const { sessionId, id } = agent;
    if (typeof sessionId !== 'string' || !sessionId || typeof id !== 'string' || !id) continue;
    ids.set(sessionId, id);
  }
  return ids;
}

// `claude agents --json` runs through a login shell so nvm/asdf-style PATH setup
// applies; that shell may print its own banner, so recover the JSON array rather
// than trusting the whole of stdout to be parseable.
function parseAgentsJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const attempts = [text];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

module.exports = {
  AGENT_POLL_INTERVAL_MS,
  AWAITING_REPLY,
  attentionReasonForAgent,
  notificationMessageForReason,
  nativeNotificationForAgent,
  computeBlockedAgentNotifications,
  liveBackgroundAgentIds,
  parseAgentsJson,
};
