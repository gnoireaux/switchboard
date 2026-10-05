// Notices when the bundle this instance was launched from has been replaced on
// disk by a different build (a rebuild rsync'ed over /Applications/<name>.app
// while the app keeps running), so the UI can say a restart would pick it up.
//
// The running build's identity is the `buildLabel` stamped into package.json
// (see instance-label.js). The installed build's label is read straight out of
// the replaced app.asar with plain fs: Electron caches an archive's header per
// path, so reading through its asar-aware fs could serve the old build's files.

// Reads one top-level file out of an asar archive. Layout: an 8-byte pickle
// whose second uint32 is the header pickle's size; the header pickle holds the
// JSON index (its length at byte 4, the JSON from byte 8); file offsets in the
// index are relative to the end of the header pickle.
function readAsarFile(fs, asarPath, fileName) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonLength = headerBuf.readInt32LE(4);
    const index = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength));
    const entry = index.files && index.files[fileName];
    if (!entry || entry.offset === undefined) throw new Error(`${fileName} not found in ${asarPath}`);
    const data = Buffer.alloc(entry.size);
    fs.readSync(fd, data, 0, entry.size, 8 + headerSize + Number(entry.offset));
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function readInstalledBuildLabel(fs, asarPath) {
  const label = JSON.parse(readAsarFile(fs, asarPath, 'package.json').toString('utf8')).buildLabel;
  return typeof label === 'string' ? label.trim() : '';
}

// The installed label when it names a different build than the running one;
// null when they match or either side is unlabelled (nothing reliable to compare).
function pendingInstalledBuild(runningLabel, installedLabel) {
  const running = typeof runningLabel === 'string' ? runningLabel.trim() : '';
  const installed = typeof installedLabel === 'string' ? installedLabel.trim() : '';
  if (!running || !installed || running === installed) return null;
  return installed;
}

// Window-title suffix for a pending build: just `@sha` when only the commit
// moved on the same branch, the whole label otherwise.
function pendingBuildTitleSuffix(runningLabel, pendingLabel) {
  if (!pendingLabel) return '';
  const branchOf = (label) => String(label || '').replace(/@[^@]*$/, '');
  const sameBranch = branchOf(runningLabel) === branchOf(pendingLabel) && pendingLabel.includes('@');
  const shown = sameBranch ? pendingLabel.slice(pendingLabel.lastIndexOf('@')) : pendingLabel;
  return ` — ⟳ restart for ${shown}`;
}

// Re-reads the installed label whenever the archive's stat changes, and calls
// onChange(pendingLabel | null) when the pending build changes. A read that
// fails (archive mid-copy) is retried on the next check.
function createInstalledBuildWatcher({ fs, asarPath, runningLabel, onChange, log }) {
  let lastStatKey = null;
  let pending = null;

  function check() {
    let statKey;
    try {
      const st = fs.statSync(asarPath);
      statKey = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (err) {
      log?.warn?.(`[installed-build] stat failed: ${err.message}`);
      return pending;
    }
    if (statKey === lastStatKey) return pending;
    let installedLabel;
    try {
      installedLabel = readInstalledBuildLabel(fs, asarPath);
    } catch (err) {
      log?.warn?.(`[installed-build] read failed, retrying next check: ${err.message}`);
      return pending;
    }
    lastStatKey = statKey;
    const next = pendingInstalledBuild(runningLabel, installedLabel);
    if (next !== pending) {
      pending = next;
      log?.info?.(`[installed-build] ${next ? `newer build installed: ${next}` : 'installed build matches running build'}`);
      onChange(pending);
    }
    return pending;
  }

  return { check, getPending: () => pending };
}

module.exports = {
  readAsarFile, readInstalledBuildLabel, pendingInstalledBuild,
  pendingBuildTitleSuffix, createInstalledBuildWatcher,
};
