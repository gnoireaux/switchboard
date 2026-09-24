const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeInitialPrompt, encodeInitialPromptForPty } = require('../initial-prompt-delivery');

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

test('a single-line prompt is wrapped in bracketed paste too, with no submit key', () => {
  const encoded = encodeInitialPromptForPty('/stream-handoffs--chain-sessions continue /tmp/chain-x/');
  assert.equal(encoded, `${BRACKETED_PASTE_START}/stream-handoffs--chain-sessions continue /tmp/chain-x/${BRACKETED_PASTE_END}`);
  assert.ok(!encoded.includes('\r'));
  assert.ok(!encoded.includes('\n'));
});

test('a long single-line prompt is bracketed, so the submit key after it is not lost', () => {
  const longPrompt = `/stream-handoffs--chain-sessions continue /abs/chain-x/ ${'then carry on with the batch '.repeat(14)}`.trim();
  assert.ok(longPrompt.length > 400);
  const encoded = encodeInitialPromptForPty(longPrompt);
  assert.ok(encoded.startsWith(BRACKETED_PASTE_START));
  assert.ok(encoded.endsWith(BRACKETED_PASTE_END));
});

test('a multi-line prompt is wrapped in bracketed paste so its newlines do not submit it', () => {
  const encoded = encodeInitialPromptForPty('first line\nsecond line');
  assert.equal(encoded, `${BRACKETED_PASTE_START}first line\nsecond line${BRACKETED_PASTE_END}`);
});

test('a carriage return in the prompt never reaches the PTY', () => {
  assert.equal(sanitizeInitialPrompt('do this\rrm -rf /'), 'do this\nrm -rf /');
  const encoded = encodeInitialPromptForPty('do this\r\nthen that');
  assert.ok(!encoded.includes('\r'));
  assert.equal(encoded, `${BRACKETED_PASTE_START}do this\nthen that${BRACKETED_PASTE_END}`);
});

test('a lone CR — the submit key on its own — becomes a newline, not a send', () => {
  assert.equal(encodeInitialPromptForPty('accept\rdeny'), `${BRACKETED_PASTE_START}accept\ndeny${BRACKETED_PASTE_END}`);
});

test('escape sequences in an untrusted prompt are stripped rather than driving the terminal', () => {
  // A prompt that tries to close bracketed paste early and then submit.
  const hostile = `benign${BRACKETED_PASTE_END}\x1b[201~rm -rf /\r`;
  const encoded = encodeInitialPromptForPty(hostile);
  const inner = encoded.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
  assert.ok(!inner.includes('\x1b'), 'no raw escape sequence survives inside the paste');
  assert.ok(!encoded.includes('\r'));
  assert.equal(encoded, `${BRACKETED_PASTE_START}benign[201~[201~rm -rf /${BRACKETED_PASTE_END}`);
  assert.equal(encoded.split(BRACKETED_PASTE_END).length, 2, 'the only paste end is the one we add');
});

test('control characters other than newline and tab are dropped', () => {
  assert.equal(sanitizeInitialPrompt('a\x00b\x07c\x7fd\te'), 'abcd\te');
});

test('trailing whitespace is trimmed, so a prompt ending in a newline stays single-line', () => {
  assert.equal(encodeInitialPromptForPty('just one line\n'), `${BRACKETED_PASTE_START}just one line${BRACKETED_PASTE_END}`);
  assert.equal(encodeInitialPromptForPty('padded   \n\n'), `${BRACKETED_PASTE_START}padded${BRACKETED_PASTE_END}`);
});

test('an empty, blank, or non-string prompt means nothing is written', () => {
  assert.equal(encodeInitialPromptForPty(''), null);
  assert.equal(encodeInitialPromptForPty('   \n\t '), null);
  assert.equal(encodeInitialPromptForPty(undefined), null);
  assert.equal(encodeInitialPromptForPty(null), null);
  assert.equal(encodeInitialPromptForPty(42), null);
  assert.equal(encodeInitialPromptForPty('\r\r\r'), null);
});

const {
  SUBMIT_KEY, INITIAL_PROMPT_SUBMIT_DELAY_MS, buildInitialPromptWrites,
} = require('../initial-prompt-delivery');

test('without auto-submit the only write is the typed prompt', () => {
  const writes = buildInitialPromptWrites('continue the chain');
  assert.deepEqual(writes, [{ payload: `${BRACKETED_PASTE_START}continue the chain${BRACKETED_PASTE_END}`, delayMs: 0 }]);
});

test('auto-submit adds the submit key as a separate, delayed write', () => {
  const writes = buildInitialPromptWrites('continue the chain', { autoSubmit: true });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], { payload: `${BRACKETED_PASTE_START}continue the chain${BRACKETED_PASTE_END}`, delayMs: 0 });
  assert.deepEqual(writes[1], { payload: SUBMIT_KEY, delayMs: INITIAL_PROMPT_SUBMIT_DELAY_MS });
  assert.ok(INITIAL_PROMPT_SUBMIT_DELAY_MS > 0, 'the submit must not race the paste');
});

test('the submit key is never part of the typed prompt, even under auto-submit', () => {
  const writes = buildInitialPromptWrites('line one\r\nline two\rrm -rf /', { autoSubmit: true });
  assert.ok(!writes[0].payload.includes(SUBMIT_KEY));
  assert.equal(writes.filter(w => w.payload === SUBMIT_KEY).length, 1);
});

test('an empty prompt writes nothing, auto-submit or not', () => {
  assert.equal(buildInitialPromptWrites('   ', { autoSubmit: true }), null);
  assert.equal(buildInitialPromptWrites(null, { autoSubmit: true }), null);
});
