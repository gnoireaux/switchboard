// Names this Switchboard instance in its window title, so side-by-side installs
// (the upstream app, a fork, per-feature dev bundles) can be told apart at a glance.
//
// The bundle's file name is the reliable identity on macOS: the fork is built
// without a productName override, so its CFBundleName and package name are the
// same as upstream's and only `/Applications/Switchboard-fork.app` differs.
// A build may also stamp `buildLabel` into package.json (electron-builder
// `-c.extraMetadata.buildLabel=<branch>@<sha>`) to say which code it runs.

const DEFAULT_APP_NAME = 'Switchboard';

// `/Applications/Foo.app/Contents/MacOS/Foo` → `Foo`; null when not inside a bundle.
function macBundleName(execPath) {
  const match = /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  return match ? match[1] : null;
}

function instanceLabel({ execPath, platform, isPackaged, buildLabel, dataDir }) {
  const parts = [];
  if (!isPackaged) {
    parts.push(`${DEFAULT_APP_NAME} (from source)`);
  } else {
    parts.push((platform === 'darwin' && macBundleName(execPath)) || DEFAULT_APP_NAME);
  }
  if (typeof buildLabel === 'string' && buildLabel.trim()) parts.push(buildLabel.trim());
  // A source run is only told apart from another one by where it keeps its data.
  if (!isPackaged && typeof dataDir === 'string' && dataDir) parts.push(dataDir);
  return parts.join(' — ');
}

module.exports = { DEFAULT_APP_NAME, macBundleName, instanceLabel };
