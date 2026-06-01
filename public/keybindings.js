// --- Central keyboard shortcuts ---
// Defaults live here; user overrides are stored in the app's global settings
// (key `keybindings`) and merged over these at startup via applyKeybindingOverrides().
// Edit shortcuts from the app: Global Settings → Keyboard Shortcuts.
//
// Only app-level navigation shortcuts live here. Editor keys live in
// codemirror-setup.js; terminal-protocol keys (Shift+Enter, Ctrl+V) stay in
// terminal-manager.js because they map to terminal byte sequences, not actions.
//
// Each binding:
//   key   — an `e.key` value, e.g. 'g', 'f', 'ArrowLeft' (letters matched case-insensitively)
//   code  — an `e.code` value, e.g. 'BracketLeft' (use for [ ] since Shift rewrites e.key to { })
//   mod   — true requires Cmd on macOS / Ctrl elsewhere
//   shift / alt — true requires that modifier, false requires it absent
const KEYBINDING_DEFAULTS = {
  terminalFind: { key: 'f',            mod: true, shift: false, alt: false },
  toggleGrid:   { key: 'g',            mod: true, shift: true,  alt: false },
  prevSession:  { code: 'BracketLeft', mod: true, shift: true,  alt: false },
  nextSession:  { code: 'BracketRight',mod: true, shift: true,  alt: false },
  navLeft:      { key: 'ArrowLeft',    mod: true, shift: false, alt: false },
  navRight:     { key: 'ArrowRight',   mod: true, shift: false, alt: false },
  navUp:        { key: 'ArrowUp',      mod: true, shift: false, alt: false },
  navDown:      { key: 'ArrowDown',    mod: true, shift: false, alt: false },
};

// Display order + human labels for the settings UI.
const KEYBINDING_LABELS = {
  terminalFind: 'Find in terminal',
  toggleGrid:   'Toggle grid view',
  prevSession:  'Previous session',
  nextSession:  'Next session',
  navLeft:      'Navigate left',
  navRight:     'Navigate right',
  navUp:        'Navigate up',
  navDown:      'Navigate down',
};

// Active bindings (defaults, possibly overridden at startup). matchKey() reads this.
let KEYBINDINGS = JSON.parse(JSON.stringify(KEYBINDING_DEFAULTS));

const _keybindingsIsMac =
  (typeof window !== 'undefined' && window.api && window.api.platform === 'darwin') ||
  /Mac|iPhone|iPad/.test(navigator.platform);

// Replace active bindings with defaults, then apply any per-action overrides.
function applyKeybindingOverrides(overrides) {
  KEYBINDINGS = JSON.parse(JSON.stringify(KEYBINDING_DEFAULTS));
  if (overrides && typeof overrides === 'object') {
    for (const action in KEYBINDING_DEFAULTS) {
      if (overrides[action]) KEYBINDINGS[action] = overrides[action];
    }
  }
}

// Returns true if the keyboard event matches the named binding.
function matchKey(keyEvent, action) {
  const binding = KEYBINDINGS[action];
  if (!binding) return false;
  const mod = _keybindingsIsMac ? keyEvent.metaKey : keyEvent.ctrlKey;
  if (!!binding.mod !== !!mod) return false;
  if (!!binding.shift !== !!keyEvent.shiftKey) return false;
  if (!!binding.alt !== !!keyEvent.altKey) return false;
  if (binding.code) return keyEvent.code === binding.code;
  return keyEvent.key.toLowerCase() === binding.key.toLowerCase();
}

// Build a binding object from a captured keydown event (used by the settings recorder).
// Returns null for lone modifier presses.
function bindingFromEvent(keyEvent) {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(keyEvent.key)) return null;
  const mod = _keybindingsIsMac ? keyEvent.metaKey : keyEvent.ctrlKey;
  const binding = { mod, shift: keyEvent.shiftKey, alt: keyEvent.altKey };
  const isLetterOrDigit = /^[a-z0-9]$/i.test(keyEvent.key);
  const isNamedKey = keyEvent.key.length > 1; // Arrow*, Enter, Tab, etc.
  // Shift rewrites punctuation (e.g. [ → {), so fall back to physical code for those.
  if (keyEvent.shiftKey && !isLetterOrDigit && !isNamedKey) {
    binding.code = keyEvent.code;
  } else {
    binding.key = isLetterOrDigit ? keyEvent.key.toLowerCase() : keyEvent.key;
  }
  return binding;
}

// Human-readable combo string, e.g. "⌘⇧G" on macOS, "Ctrl+Shift+[" elsewhere.
function bindingDisplay(binding) {
  if (!binding) return '—';
  const parts = [];
  if (binding.mod) parts.push(_keybindingsIsMac ? '⌘' : 'Ctrl');
  if (binding.alt) parts.push(_keybindingsIsMac ? '⌥' : 'Alt');
  if (binding.shift) parts.push(_keybindingsIsMac ? '⇧' : 'Shift');
  let label;
  if (binding.code === 'BracketLeft') label = '[';
  else if (binding.code === 'BracketRight') label = ']';
  else if (binding.code) label = binding.code;
  else label = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[binding.key] || binding.key;
  parts.push(String(label).length === 1 ? String(label).toUpperCase() : label);
  return parts.join(_keybindingsIsMac ? '' : '+');
}
