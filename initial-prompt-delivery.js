// Encodes a session's initial prompt for injection into a freshly started
// Claude CLI PTY.
//
// Two modes:
//  - typed only (default): the prompt lands in the CLI's input box and the
//    human presses Enter. That is what an untrusted origin gets.
//  - auto-submit: a trusted origin (the human typing into the new-session
//    dialog, or a caller holding the launch socket's 0600 token) may ask for
//    the prompt to be sent too, so two sessions chained on one mission need no
//    keystroke at all.
//
// Either way the prompt itself can never submit: the sanitizer strips CR and
// ESC, so the only carriage return that ever reaches the PTY is SUBMIT_KEY,
// written deliberately by the caller.

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

// How long to wait for the CLI to report itself idle before injecting anyway.
const INITIAL_PROMPT_FALLBACK_MS = 20000;

// The key that sends the prompt. Written as a separate PTY write, never as
// part of the encoded prompt.
const SUBMIT_KEY = '\r';

// Settle margin between the paste and the submit key: the CLI renders a
// bracketed paste asynchronously, and a CR that arrives mid-paste is read as
// part of it. Not measured — raise it if a submit is ever seen landing early.
const INITIAL_PROMPT_SUBMIT_DELAY_MS = 250;

// Drops every C0 control character except newline and tab. Carriage return is
// the important one — it would submit the prompt — but ESC matters just as
// much: an escape sequence in an untrusted prompt could drive the terminal
// rather than land in the input box.
function sanitizeInitialPrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+$/, '');
}

// Returns the bytes to write to the PTY, or null when there is nothing to send.
// Multi-line prompts go through bracketed paste so their newlines stay in the
// input box instead of submitting line by line.
function encodeInitialPromptForPty(prompt) {
  const clean = sanitizeInitialPrompt(prompt);
  if (!clean) return null;
  if (!clean.includes('\n')) return clean;
  return BRACKETED_PASTE_START + clean + BRACKETED_PASTE_END;
}

// The full write sequence for a queued prompt: the typed prompt, then — only
// for a trusted origin that asked for it — the submit key as a separate,
// delayed write. Returns null when there is nothing to type.
function buildInitialPromptWrites(prompt, { autoSubmit = false } = {}) {
  const payload = encodeInitialPromptForPty(prompt);
  if (payload === null) return null;
  const writes = [{ payload, delayMs: 0 }];
  if (autoSubmit) writes.push({ payload: SUBMIT_KEY, delayMs: INITIAL_PROMPT_SUBMIT_DELAY_MS });
  return writes;
}

module.exports = {
  INITIAL_PROMPT_FALLBACK_MS,
  INITIAL_PROMPT_SUBMIT_DELAY_MS,
  SUBMIT_KEY,
  sanitizeInitialPrompt,
  encodeInitialPromptForPty,
  buildInitialPromptWrites,
};
