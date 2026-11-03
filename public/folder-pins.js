// Pinned folder groups on the Sessions tab. A pinned folder is a primary one:
// its group sorts above every unpinned group and gets a tinted background.
// The pin belongs to the folder path and is stored as one setting (an array of
// paths) in the app database. It is unrelated to the per-session star.
(function (root) {
  const PINNED_FOLDERS_SETTING_KEY = 'pinnedSessionFolders';

  /** Whatever the setting holds, a clean list of distinct non-empty paths. */
  function normalizePinnedFolders(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    for (const entry of value) {
      if (typeof entry === 'string' && entry && !seen.has(entry)) seen.add(entry);
    }
    return [...seen];
  }

  /** The list with `folderPath` added when absent, removed when present. */
  function togglePinnedFolder(pinnedFolders, folderPath) {
    const current = normalizePinnedFolders(pinnedFolders);
    return current.includes(folderPath)
      ? current.filter(p => p !== folderPath)
      : [...current, folderPath];
  }

  /**
   * Pinned groups first, each side keeping the order it came in, so the
   * caller's own ordering (recency, or the order already on screen) still
   * decides within the pinned groups and within the others.
   */
  function orderPinnedFoldersFirst(projects, pinnedFolders) {
    const pinned = pinnedFolders instanceof Set ? pinnedFolders : new Set(normalizePinnedFolders(pinnedFolders));
    if (pinned.size === 0) return projects;
    const first = [];
    const rest = [];
    for (const project of projects) (pinned.has(project.projectPath) ? first : rest).push(project);
    return [...first, ...rest];
  }

  /**
   * Toggle `folderPath`, show the result at once through `apply(paths)`, then
   * store it. When the write fails, `apply` gets what the database still holds
   * (or, unreadable too, the list from before the click), so the screen never
   * shows a pin that a restart would lose.
   */
  async function togglePinnedFolderAndSave(currentPaths, folderPath, { getSetting, setSetting, apply, logError }) {
    const next = togglePinnedFolder(currentPaths, folderPath);
    apply(next);
    try {
      await setSetting(PINNED_FOLDERS_SETTING_KEY, next);
    } catch (err) {
      logError(err);
      let stored = normalizePinnedFolders(currentPaths);
      try { stored = normalizePinnedFolders(await getSetting(PINNED_FOLDERS_SETTING_KEY)); } catch { /* keep the list from before */ }
      apply(stored);
    }
  }

  const api = {
    PINNED_FOLDERS_SETTING_KEY, normalizePinnedFolders, togglePinnedFolder, orderPinnedFoldersFirst,
    togglePinnedFolderAndSave,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
