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

// Reason strings are the stable identity of "why this session needs attention".
// A change of reason (input needed → permission prompt) re-triggers a
// notification; an unchanged reason stays silent however long it lasts.
function attentionReasonForAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const isBlocked = agent.state === 'blocked' || agent.status === 'waiting';
  if (!isBlocked) return null;
  if (typeof agent.waitingFor === 'string' && agent.waitingFor) return agent.waitingFor;
  return 'blocked';
}

// Phrased like the Claude CLI's own notifications, since the text is shown in
// the terminal header. The badge does not depend on it: main sends these with
// kind 'attention' (see pollBlockedAgents in main.js).
function notificationMessageForReason(reason) {
  if (reason === WAITING_FOR_PERMISSION) return 'Claude needs your permission to continue';
  if (reason === WAITING_FOR_INPUT) return 'Claude Code needs your attention — input needed';
  return 'Claude Code needs your attention';
}

// Pure diff step: given this tick's agent list, which sessions Switchboard hosts,
// and the reasons recorded last tick, return the notifications to raise now and
// the reasons to remember for the next tick.
//
// Hosted sessions are tracked but never notified — their reason is remembered so
// that closing their terminal in Switchboard doesn't fire a stale notification.
function computeBlockedAgentNotifications({ agents, hostedSessionIds, previousReasons }) {
  const hosted = hostedSessionIds instanceof Set ? hostedSessionIds : new Set(hostedSessionIds || []);
  const previous = previousReasons instanceof Map ? previousReasons : new Map();
  const reasons = new Map();
  const notifications = [];

  for (const agent of Array.isArray(agents) ? agents : []) {
    const sessionId = agent && agent.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) continue;
    const reason = attentionReasonForAgent(agent);
    if (!reason) continue;

    reasons.set(sessionId, reason);
    if (hosted.has(sessionId)) continue;
    if (previous.get(sessionId) === reason) continue;

    notifications.push({
      sessionId,
      reason,
      message: notificationMessageForReason(reason),
      cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
      name: typeof agent.name === 'string' ? agent.name : null,
    });
  }

  return { notifications, reasons };
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
  attentionReasonForAgent,
  notificationMessageForReason,
  computeBlockedAgentNotifications,
  parseAgentsJson,
};
