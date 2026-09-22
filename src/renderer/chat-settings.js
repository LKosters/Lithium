const { MODES, DEFAULT_CHAT_SETTINGS } = require('../shared/chat-options');

function createChatSettings(ipc, overlay) {
  const nav = document.createElement('button');
  nav.className = 'settings-nav-item'; nav.dataset.settingsTab = 'chats';
  nav.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>Chats</span>';
  overlay.querySelector('.settings-nav').insertBefore(nav, overlay.querySelector('[data-settings-tab="appearance"]'));
  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.dataset.settingsPanel = 'chats';
  panel.innerHTML = `
    <h2 class="settings-panel-title">Chat defaults</h2>
    <p class="settings-panel-desc">Your starting point for new conversations. You can adjust these choices in each chat.</p>
    <div class="settings-group chat-defaults-group">
      <label class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Provider</span><span class="settings-row-desc">Use your connected subscription</span></span><select name="provider" aria-label="Default provider"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <label class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Model</span><span class="settings-row-desc">Available through your provider</span></span><select name="model" aria-label="Default model"></select></label>
      <label class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Reasoning effort</span><span class="settings-row-desc">Options depend on the selected model</span></span><select name="effort" aria-label="Default reasoning effort"></select></label>
      <label class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Permissions</span><span class="settings-row-desc">Enforced by the native agent</span></span><select name="permissionMode" aria-label="Default permissions"></select></label>
    </div>
    <p class="settings-group-hint chat-defaults-policy"></p>
    <div class="chat-defaults-connection"><span role="status" data-connection></span><button type="button" class="settings-btn-sm" data-refresh>Refresh models</button></div>
    <div class="chat-defaults-footer"><span role="status" data-status></span><button type="button" class="settings-btn-sm settings-btn-accent" data-save>Save defaults</button></div>
    <p class="settings-group-hint">Applies to new chats in every project. Existing chats keep their settings. “Provider default” follows the agent’s configuration in that workspace.</p>`;
  overlay.querySelector('.settings-main').append(panel);
  const field = name => panel.querySelector(`[name="${name}"]`);
  const status = panel.querySelector('[data-status]'), connection = panel.querySelector('[data-connection]');
  const save = panel.querySelector('[data-save]'), refresh = panel.querySelector('[data-refresh]');
  let draft = { ...DEFAULT_CHAT_SETTINGS }, models = [], generation = 0, loading = false, saving = false, dirty = false;
  const providerDrafts = {};
  async function invoke(channel, input) {
    const result = await ipc.invoke(channel, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  function options(select, list, value) {
    select.replaceChildren(...list.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option;
    }));
    if (value && !list.some(item => item.id === value)) {
      const option = document.createElement('option'); option.value = value; option.textContent = `${value} (saved)`; select.append(option);
    }
    select.value = value;
  }
  function render() {
    field('provider').value = draft.provider;
    options(field('model'), [{ id: '', label: 'Provider default' }, ...models], draft.model);
    const efforts = models.find(m => m.id === draft.model)?.efforts || [];
    options(field('effort'), [{ id: '', label: 'Provider default' }, ...efforts.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }))], draft.effort);
    options(field('permissionMode'), MODES[draft.provider], draft.permissionMode);
    const mode = MODES[draft.provider].find(m => m.id === draft.permissionMode);
    const hint = panel.querySelector('.chat-defaults-policy'); hint.textContent = mode.description; hint.classList.toggle('danger', !!mode.danger);
    panel.querySelectorAll('select').forEach(select => { select.disabled = loading || saving; });
    field('effort').disabled ||= !efforts.length && !draft.effort;
    save.disabled = loading || saving || !dirty; refresh.disabled = loading || saving;
  }
  async function catalog() {
    const version = ++generation, provider = draft.provider;
    connection.textContent = 'Loading available models…'; refresh.disabled = true;
    try {
      const result = await invoke('chat:defaults:catalog', { provider });
      if (version !== generation) return;
      models = result.models || []; connection.textContent = result.account || 'Connected'; render();
    } catch (error) {
      if (version !== generation) return;
      connection.textContent = `${error.message} Your saved choices are kept.`;
    } finally { if (version === generation) refresh.disabled = loading || saving; }
  }
  panel.addEventListener('change', event => {
    const name = event.target.name;
    if (!['provider', 'model', 'effort', 'permissionMode'].includes(name)) return;
    if (name === 'provider') {
      providerDrafts[draft.provider] = { ...draft };
      draft = providerDrafts[event.target.value] || { ...DEFAULT_CHAT_SETTINGS, provider: event.target.value };
      models = []; catalog();
    } else {
      draft[name] = event.target.value;
      if (name === 'model') draft.effort = '';
    }
    dirty = true; status.textContent = 'Unsaved changes'; render();
  });
  refresh.addEventListener('click', catalog);
  save.addEventListener('click', async () => {
    saving = true; status.textContent = 'Saving…'; render();
    try { draft = await invoke('chat:defaults:set', { ...draft }); dirty = false; status.textContent = 'Saved for new chats'; }
    catch (error) { status.textContent = `Could not save: ${error.message}`; }
    finally { saving = false; render(); }
  });
  async function load() {
    if (saving || loading || dirty) return;
    ++generation; loading = true; status.textContent = ''; render();
    try { draft = await invoke('chat:defaults:get'); models = []; }
    catch (error) { status.textContent = `Could not load defaults: ${error.message}`; }
    finally { loading = false; render(); }
    catalog();
  }
  render();
  return { load };
}
module.exports = { createChatSettings };
