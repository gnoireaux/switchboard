// legacy-schedule-command.js — Remove the schedule-creator command older builds installed.
// Before #96, Switchboard wrote ~/.claude/commands/create-switchboard-schedule.md
// whenever it was missing. #96 moved schedules into the database and dropped the
// installer, but left the file behind, so every Claude session still lists a
// command that writes the legacy schedule-*.md files. Only a byte-exact copy of a
// shipped template is removed: an edited copy belongs to the user and stays.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LEGACY_COMMAND_PATH = path.join(os.homedir(), '.claude', 'commands', 'create-switchboard-schedule.md');

// SHA-256 of each SCHEDULE_CREATOR_TEMPLATE that shipped: f1332a9, then
// 89b38a5 (unchanged through 31c3029, the last version before #96).
const SHIPPED_TEMPLATE_SHA256 = new Set([
  '4432f59e494f84aa61d2023af7a3455e1e476eb913869c8ec51e2fefbebf75e7',
  'fa7685454d5e4dc3fdac9c90908eae8ae0cbcb3344bec39573850a5788db1221',
]);

/** Delete the legacy command if it is an unedited shipped template. Returns true when removed. */
function removeLegacyScheduleCommand(commandPath = LEGACY_COMMAND_PATH) {
  let content;
  try {
    content = fs.readFileSync(commandPath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  if (!SHIPPED_TEMPLATE_SHA256.has(sha256)) return false;
  fs.unlinkSync(commandPath);
  return true;
}

module.exports = { removeLegacyScheduleCommand, LEGACY_COMMAND_PATH };
