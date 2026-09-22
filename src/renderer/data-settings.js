function createDataSettings(ipc, overlay) {
  const nav = document.createElement('button');
  nav.className = 'settings-nav-item'; nav.dataset.settingsTab = 'data';
  nav.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" stroke-width="1.5"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" stroke="currentColor" stroke-width="1.5"/></svg><span>Data & backups</span>';
  overlay.querySelector('.settings-nav').append(nav);
  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.dataset.settingsPanel = 'data';
  panel.innerHTML = `
    <h2 class="settings-panel-title">Data & backups</h2>
    <p class="settings-panel-desc">Your conversations and preferences, stored locally and kept through app updates.</p>
    <div class="settings-group">
      <div class="settings-row settings-row-stack"><span class="settings-row-name">Local database</span><span class="settings-row-desc" data-counts>Loading…</span><code class="data-storage-path"></code></div>
      <div class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Export your data</span><span class="settings-row-desc">Save a portable copy of your chats and settings</span></span><button class="settings-btn-sm settings-btn-accent" data-export>Export backup</button></div>
      <div class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Restore a backup</span><span class="settings-row-desc">Review a backup before replacing your current data</span></span><button class="settings-btn-sm" data-import>Import backup</button></div>
    </div>
    <h3 class="settings-group-title">What’s included</h3>
    <p class="settings-group-hint">Chat history, session settings, images, drafts, app preferences, recent projects, open tabs and global instructions.</p>
    <p class="settings-group-hint">Project files, project-specific settings and provider credentials are separate. Claude and Codex keep their own native sessions; continuing a conversation on another computer also requires those sessions and the original project folder.</p>
    <p class="settings-group-hint">Imports are checked before use. Restoring stops active agents, saves a recovery backup and restarts Lithium. Backup files contain your conversations and are not encrypted. Maximum backup size: 512 MB.</p>
    <p class="data-backup-status" role="status"></p>`;
  overlay.querySelector('.settings-main').append(panel);
  const status = panel.querySelector('.data-backup-status');
  async function invoke(channel) {
    const result = await ipc.invoke(channel);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async function load() {
    try {
      const info = await invoke('data:info');
      panel.querySelector('.data-storage-path').textContent = info.file;
      panel.querySelector('[data-counts]').textContent = `${info.sessions} sessions · ${info.chats} chats · ${info.messages} messages`;
    } catch (error) { status.textContent = error.message; }
  }
  for (const action of ['export', 'import']) panel.querySelector(`[data-${action}]`).addEventListener('click', async () => {
    require('./preferences').flush();
    panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = action === 'export' ? 'Choose where to save your backup…' : 'Choose a backup to review…';
    try {
      const result = await invoke(`data:${action}`);
      status.textContent = result.canceled ? 'Canceled. Your data is unchanged.' : action === 'export' ? `Backup saved to ${result.file}` : 'Restoring your data. Lithium will restart…';
    } catch (error) { status.textContent = `Could not ${action}: ${error.message}`; }
    finally { panel.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  });
  return { load };
}
module.exports = { createDataSettings };
