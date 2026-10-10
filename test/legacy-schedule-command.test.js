const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { removeLegacyScheduleCommand } = require('../legacy-schedule-command');

// Fixtures are SCHEDULE_CREATOR_TEMPLATE as shipped in schedule-ipc.js at each commit.
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'legacy-schedule-command');
const SHIPPED_TEMPLATES = ['f1332a9.md', '89b38a5.md'];

function withCommandFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-schedule-command-test-'));
  const commandPath = path.join(dir, 'create-switchboard-schedule.md');
  try {
    if (content !== null) fs.writeFileSync(commandPath, content);
    return fn(commandPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of SHIPPED_TEMPLATES) {
  test(`removes an unedited copy of the template shipped in ${path.basename(name, '.md')}`, () => {
    const shipped = fs.readFileSync(path.join(FIXTURE_DIR, name));
    withCommandFile(shipped, commandPath => {
      assert.equal(removeLegacyScheduleCommand(commandPath), true);
      assert.equal(fs.existsSync(commandPath), false);
    });
  });
}

test('keeps a copy the user edited', () => {
  const edited = fs.readFileSync(path.join(FIXTURE_DIR, '89b38a5.md'), 'utf8') + '\n- My own note\n';
  withCommandFile(edited, commandPath => {
    assert.equal(removeLegacyScheduleCommand(commandPath), false);
    assert.equal(fs.readFileSync(commandPath, 'utf8'), edited);
  });
});

test('does nothing when the command file is absent', () => {
  withCommandFile(null, commandPath => {
    assert.equal(removeLegacyScheduleCommand(commandPath), false);
  });
});
