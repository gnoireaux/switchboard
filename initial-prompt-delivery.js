// Encodes a session's initial prompt for injection into a freshly started
// Claude CLI PTY.
//
// The prompt is typed into the CLI's input box and deliberately NOT submitted:
// the human reads it and presses Enter. That is the whole safety model for
// prompts that arrive from outside the app (a successor launched by another
// session, a future URL handler), so the encoder has to make "not submitted"
// true for any input, not just well-behaved ones.

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

// How long to wait for the CLI to report itself idle before injecting anyway.
const INITIAL_PROMPT_FALLBACK_MS = 20000;

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

module.exports = {
  INITIAL_PROMPT_FALLBACK_MS,
  sanitizeInitialPrompt,
  encodeInitialPromptForPty,
};
