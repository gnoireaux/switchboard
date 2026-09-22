// Environment for PTY children.
//
// Two jobs:
//
// 1. Strip Electron internals that cause nested Electron apps (or node-pty
//    inside them) to malfunction.
//
// 2. Cut the launching session's own identity out of the child's environment.
//    Switchboard is often started from a shell inside a Claude session, and a
//    session it then spawns is a sibling of that one, not a subagent of it:
//    the human watches it in its own tab. Left in place, CLAUDE_CODE_CHILD_SESSION
//    makes the CLI treat it as a nested run and stop saving its transcript —
//    which Switchboard reads to build every sidebar row — and a leaked
//    CLAUDE_CODE_SESSION_ID points hooks and scripts at the wrong session
//    entirely. Only these markers go; deliberate CLAUDE_CODE_* configuration
//    (output limits, provider selection) is the user's and stays.
//
// 3. Guarantee a UTF-8 character encoding. An app launched from Finder or the
//    Dock on macOS inherits no shell environment, so LANG/LC_* are simply
//    absent — launchd does not set them. Locale-sensitive tools then fall back
//    to the "standard C encoding", which on macOS means Mac OS Roman. `pbcopy`
//    is the one users notice: it reads UTF-8 bytes as Mac OS Roman, so an
//    agent response copied out of a session arrives on the clipboard as
//    "‚Ä¶‚Äî‚Üí" instead of "…—→" (issue #89).
//
//    LC_CTYPE alone is deliberate. It fixes character handling and nothing
//    else — collation, dates, and number formatting stay on the system
//    default rather than being forced to some guessed region.

const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

// The launching session's identity, never the new session's.
const SESSION_LINEAGE_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'];

function buildPtyEnv(sourceEnv) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([k]) =>
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('GOOGLE_API_KEY') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      k !== 'WT_SESSION' &&
      !SESSION_LINEAGE_VARS.includes(k)
    )
  );

  // Stripping the marker is what normally restores transcripts; this pins the
  // outcome whatever else in the environment would suppress them. A session
  // whose transcript is not written is invisible to Switchboard.
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';

  // Only when the parent handed us nothing usable — an inherited locale is the
  // user's own setting and must win. An empty value counts as absent, which is
  // what a GUI launch actually produces.
  if (!LOCALE_VARS.some((k) => env[k])) env.LC_CTYPE = 'UTF-8';

  return env;
}

module.exports = { buildPtyEnv };
