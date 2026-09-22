const preferences = require('./preferences');
const app = require('./app');
const { terminals } = require('./state');
const { escapeHtml, persistSession, dirName } = require('./helpers');
// Provider labels and questions also appear in attributes, where quotes matter.
const esc = value => escapeHtml(String(value ?? '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const { MODES } = require('../shared/chat-options');
const { renderMarkdown } = require('./chat-markdown');
const icon = (name, size = 16) => {
  const paths = {
    send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z"/><path d="m9 12 2 2 4-4"/>',
    sparkle: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sparkle}</svg>`;
};
async function invoke(channel, input) {
  const result = await app.ipcRenderer.invoke(channel, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function createChatPane(session) {
  const id = session.id;
  const paneEl = document.createElement('section');
  paneEl.className = 'chat-pane'; paneEl.setAttribute('aria-label', 'Agent chat');
  paneEl.innerHTML = `
    <header class="chat-header">
      <div class="chat-header-project"><span class="chat-project-icon">${icon('sparkle')}</span><span>${esc(dirName(session.directory))}</span><span class="chat-header-divider">/</span><span class="chat-header-label">Chat</span></div>
      <button class="chat-account" data-action="refresh" title="Refresh account and available models"><span class="chat-connection-dot"></span><span class="chat-account-label">Checking connection</span>${icon('refresh', 12)}</button>
    </header>
    <div class="chat-scroll">
      <div class="chat-empty">
        <div class="chat-empty-mark">${icon('sparkle', 32)}</div>
        <span class="chat-eyebrow">A LITTLE SPACE FOR BIG IDEAS</span>
        <h1>What are we building?</h1>
        <p>Start with a question, a rough idea, or that one thing<br class="chat-wide-only"> you’ve been meaning to fix.</p>
        <div class="chat-starters">
          <button data-prompt="Explore this project and explain its architecture. Don't change any files."><span>Understand this project</span><small>Find your way around the code</small>${icon('arrow')}</button>
          <button data-prompt="Help me plan a feature. Ask me what I want to build before making any changes."><span>Plan something new</span><small>Turn an idea into a clear next step</small>${icon('arrow')}</button>
          <button data-prompt="Review this project's code for bugs. Explain what you find before changing any files."><span>Find what needs fixing</span><small>Get a fresh pair of eyes</small>${icon('arrow')}</button>
        </div>
      </div>
      <div class="chat-timeline" aria-label="Conversation"></div>
      <div class="chat-working hidden" role="status"><span class="chat-spinner"></span><span>Working</span><span class="chat-elapsed"></span></div>
    </div>
    <button class="chat-jump hidden" data-action="bottom">Jump to latest ↓</button>
    <div class="chat-bottom">
      <div class="chat-requests" aria-live="polite"></div>
      <div class="chat-error hidden" role="alert"><span></span><button data-action="retry">Edit & retry</button></div>
      <div class="chat-composer">
        <div class="chat-attachments"></div>
        <textarea class="chat-input" rows="2" aria-label="Message your agent" placeholder="Ask, plan, build…" spellcheck="false"></textarea>
        <div class="chat-composer-toolbar">
          <div class="chat-controls">
            <button class="chat-icon-button" data-action="attach" aria-label="Attach images" title="Attach images">${icon('plus')}</button>
            <button class="chat-select chat-provider-button" data-menu="provider"><span>Claude</span>${icon('chevron', 12)}</button>
            <button class="chat-select chat-model-button" data-menu="model"><span>Default model</span>${icon('chevron', 12)}</button>
            <button class="chat-select chat-effort-button hidden" data-menu="effort"><span>Default effort</span>${icon('chevron', 12)}</button>
          </div>
          <button class="chat-send" data-action="send" aria-label="Send message" disabled>${icon('send', 19)}</button>
        </div>
        <div class="chat-menu hidden" role="dialog" aria-label="Session settings"></div>
      </div>
      <footer class="chat-footer"><button class="chat-permission" data-menu="permission">${icon('shield', 13)}<span>Default</span>${icon('chevron', 11)}</button><span class="chat-usage"></span><span class="chat-key-hint">↵ Send <span>·</span> ⇧↵ New line</span></footer>
    </div>`;
  const $ = s => paneEl.querySelector(s);
  const input = $('.chat-input'), scroll = $('.chat-scroll'), timeline = $('.chat-timeline'), menu = $('.chat-menu');
  let doc = null, disposed = false, busy = false, ready = false, settingsBusy = false, atBottom = true, frame = null, catalogVersion = 0, startedAt = 0;
  let models = [], attachments = [], accountLabel = '', catalogError = '', currentMenu = null;
  const rows = new Map(), dirty = new Set(), buffered = [], requests = new Map();
  const draftKey = `lithium-chat-draft-${id}`;
  input.value = localStorage.getItem(draftKey) || '';
  const runtime = { kind: 'chat', paneEl, alive: false, focus: () => input.focus(), dispose: () => {
    disposed = true; clearInterval(ticker); if (frame) cancelAnimationFrame(frame); app.ipcRenderer.removeListener('chat:event', onEvent); document.removeEventListener('pointerdown', outside);
  } };
  terminals.set(id, runtime);

  function error(message) { $('.chat-error span').textContent = message || ''; $('.chat-error').classList.toggle('hidden', !message); }
  function resize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
  function toBottom() { scroll.scrollTop = scroll.scrollHeight; atBottom = true; $('.chat-jump').classList.add('hidden'); }
  function syncControls() {
    if (!doc) return;
    busy = ['working', 'stopping'].includes(doc.status);
    runtime.alive = busy;
    const label = doc.settings.provider === 'codex' ? 'Codex' : 'Claude';
    $('.chat-provider-button span').textContent = label;
    $('.chat-model-button span').textContent = models.find(m => m.id === doc.settings.model)?.label || doc.settings.model || 'Default model';
    $('.chat-effort-button span').textContent = doc.settings.effort ? `${doc.settings.effort[0].toUpperCase()}${doc.settings.effort.slice(1)} effort` : 'Default effort';
    const selected = models.find(m => m.id === doc.settings.model);
    $('.chat-effort-button').classList.toggle('hidden', !selected?.efforts?.length);
    const mode = MODES[doc.settings.provider].find(m => m.id === doc.settings.permissionMode);
    $('.chat-permission span').textContent = mode.label;
    $('.chat-permission').classList.toggle('is-danger', !!mode.danger);
    $('.chat-permission').title = mode.description + (doc.effective ? `\nActive: ${JSON.stringify(doc.effective)}` : '');
    paneEl.querySelectorAll('[data-menu]').forEach(b => { b.disabled = !ready || busy || settingsBusy; });
    $('.chat-provider-button').disabled ||= !!doc.nativeId || doc.entries.some(e => e.kind === 'user');
    $('.chat-provider-button').title = $('.chat-provider-button').disabled ? 'Start a new chat to change provider' : 'Choose agent';
    const send = $('.chat-send');
    send.innerHTML = icon(busy ? 'stop' : 'send', 19);
    send.setAttribute('aria-label', busy ? 'Stop response' : 'Send message');
    send.classList.toggle('is-stop', busy);
    send.disabled = !ready || settingsBusy || doc.status === 'stopping' || (!busy && !input.value.trim() && !attachments.length);
    input.placeholder = busy ? `${label} is working. You can draft your next message…` : `Message ${label}…`;
    $('.chat-working').classList.toggle('hidden', !busy);
    $('.chat-working > span:nth-child(2)').textContent = requests.size ? 'Waiting for you' : doc.status === 'stopping' ? 'Stopping' : `${label} is working`;
    $('.chat-empty').classList.toggle('hidden', doc.entries.length > 0);
    const usage = doc.usage;
    const tokens = usage?.last?.totalTokens || ((usage?.input || 0) + (usage?.output || 0));
    $('.chat-usage').textContent = tokens ? `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} tokens` : '';
  }
  function schedule() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      for (const entryId of dirty) {
        const entry = doc.entries.find(e => e.id === entryId);
        if (entry) renderEntry(entry);
      }
      dirty.clear(); syncControls();
      if (atBottom) toBottom();
    });
  }
  function renderEntry(e) {
    let row = rows.get(e.id);
    if (!row) {
      row = document.createElement('article'); row.className = `chat-entry chat-${e.kind}`; row.dataset.entryId = e.id;
      if (e.kind === 'tool' || e.kind === 'thinking') row.innerHTML = '<details><summary><span class="chat-tool-symbol"></span><span class="chat-tool-title"></span><span class="chat-tool-status"></span><span class="chat-tool-chevron">›</span></summary><div class="chat-tool-body"><pre class="chat-tool-input"></pre><div class="chat-entry-body"></div></div></details>';
      else row.innerHTML = `<div class="chat-message-meta"><span class="chat-avatar">${e.kind === 'user' ? 'Y' : icon('sparkle', 13)}</span><span class="chat-author"></span><time></time><button class="chat-copy" data-copy="message" title="Copy message" aria-label="Copy message">${icon('copy', 13)}</button></div><div class="chat-entry-body"></div><div class="chat-message-images"></div>`;
      rows.set(e.id, row); timeline.appendChild(row);
    }
    const body = row.querySelector('.chat-entry-body');
    if (e.kind === 'tool' || e.kind === 'thinking') {
      row.querySelector('.chat-tool-title').textContent = e.title || (e.kind === 'thinking' ? 'Thinking' : 'Tool');
      row.querySelector('.chat-tool-symbol').textContent = e.kind === 'thinking' ? '✧' : '⌘';
      row.querySelector('.chat-tool-status').textContent = e.status === 'running' ? 'Running' : e.status === 'error' ? 'Failed' : e.status === 'interrupted' ? 'Stopped' : '';
      row.classList.toggle('is-running', e.status === 'running');
      row.classList.toggle('is-error', e.status === 'error');
      const pre = row.querySelector('.chat-tool-input'); pre.textContent = e.input || ''; pre.hidden = !e.input;
      if (e.kind === 'tool') { body.className = 'chat-entry-body chat-tool-output'; body.textContent = e.text || ''; }
      else body.innerHTML = renderMarkdown(e.text);
    } else {
      row.querySelector('.chat-author').textContent = e.kind === 'user' ? 'You' : e.kind === 'notice' ? 'Session' : doc.settings.provider === 'codex' ? 'Codex' : 'Claude';
      row.querySelector('time').textContent = new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (e.kind === 'user') body.textContent = e.text;
      else body.innerHTML = renderMarkdown(e.text);
      body.querySelectorAll('pre').forEach(pre => {
        const button = document.createElement('button'); button.className = 'chat-code-copy'; button.dataset.copy = 'code'; button.textContent = 'Copy'; pre.appendChild(button);
      });
      const imgs = row.querySelector('.chat-message-images');
      if (e.attachments?.length && !imgs.childElementCount) for (const a of e.attachments) {
        if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(a.dataUrl)) continue;
        const img = document.createElement('img'); img.src = a.dataUrl; img.alt = a.name; imgs.appendChild(img);
      }
    }
  }
  function apply(event) {
    if (event.revision <= (doc.revision || 0)) return;
    doc.revision = event.revision;
    if (event.type === 'entry') {
      const previous = doc.entries.find(e => e.id === event.entry.id);
      if (previous) Object.assign(previous, event.entry); else doc.entries.push(event.entry);
      dirty.add(event.entry.id);
    }
    if (event.type === 'state') {
      const wasBusy = busy; Object.assign(doc, event.state); syncControls();
      if (wasBusy !== busy) { if (busy) startedAt = Date.now(); app.renderSessionList(); }
      if ('error' in event.state) error(event.state.error);
    }
    if (event.type === 'request') { requests.set(event.request.id, event.request); renderRequests(); }
    if (event.type === 'resolved') { requests.delete(event.id); renderRequests(); }
    if (event.type === 'persistence-error') error(`Could not save this conversation: ${event.error}`);
    schedule();
  }
  function onEvent(_event, event) {
    if (event.sessionId !== id || disposed) return;
    if (!doc) buffered.push(event); else apply(event);
  }
  app.ipcRenderer.on('chat:event', onEvent);

  async function refreshCatalog() {
    if (!doc) return;
    const version = ++catalogVersion;
    $('.chat-account-label').textContent = 'Checking connection';
    $('.chat-account').disabled = true;
    try {
      const result = await invoke('chat:catalog', { sessionId: id, provider: doc.settings.provider });
      if (disposed || version !== catalogVersion) return;
      models = result.models || []; accountLabel = result.account; catalogError = '';
      $('.chat-connection-dot').classList.toggle('connected', result.connected);
    } catch (err) {
      if (disposed || version !== catalogVersion) return;
      models = []; accountLabel = 'Connect account'; catalogError = err.message;
      $('.chat-connection-dot').classList.remove('connected');
    } finally {
      if (!disposed && version === catalogVersion) {
        $('.chat-account-label').textContent = accountLabel; $('.chat-account').title = catalogError || `${accountLabel} · Refresh models and connection`;
        $('.chat-account').disabled = false; syncControls();
        if (currentMenu === 'model') openMenu('model');
      }
    }
  }
  async function configure(values) {
    if (busy || settingsBusy) return;
    settingsBusy = true; closeMenu(); syncControls();
    const oldProvider = doc.settings.provider;
    try {
      const result = await invoke('chat:configure', { sessionId: id, settings: { ...doc.settings, ...values } });
      doc.settings = result.settings; doc.effective = result.effective;
      if (oldProvider !== doc.settings.provider) { models = []; refreshCatalog(); }
      error('');
    } catch (err) { error(err.message); }
    finally { settingsBusy = false; syncControls(); }
  }
  function closeMenu() { currentMenu = null; menu.classList.add('hidden'); paneEl.querySelectorAll('[data-menu]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
  function openMenu(kind) {
    if (!ready || busy || settingsBusy) return;
    currentMenu = kind;
    let options, title, value;
    if (kind === 'permission') { options = MODES[doc.settings.provider]; title = 'Session permissions'; value = doc.settings.permissionMode; }
    if (kind === 'provider') { options = [{ id: 'claude', label: 'Claude', description: 'Your Claude Code account and settings' }, { id: 'codex', label: 'Codex', description: 'Your ChatGPT account and Codex settings' }]; title = 'Choose your agent'; value = doc.settings.provider; }
    if (kind === 'model') { options = [{ id: '', label: 'Default model', description: 'Use the model from your agent’s configuration' }, ...models]; title = 'Choose a model'; value = doc.settings.model; }
    if (kind === 'effort') { options = [{ id: '', label: 'Default effort' }, ...(models.find(m => m.id === doc.settings.model)?.efforts || []).map(e => ({ id: e, label: e[0].toUpperCase() + e.slice(1) }))]; title = 'Reasoning effort'; value = doc.settings.effort; }
    menu.innerHTML = `<div class="chat-menu-heading">${title}<button data-action="close-menu" aria-label="Close menu">×</button></div><div class="chat-menu-options">${options.map(o => `<button class="chat-menu-option ${o.danger ? 'danger' : ''}" data-option="${esc(o.id)}" role="radio" aria-checked="${value === o.id}"><span class="chat-option-check">${value === o.id ? '✓' : ''}</span><span><strong>${esc(o.label)}</strong>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></button>`).join('')}</div>${kind === 'model' && catalogError ? `<div class="chat-menu-note">${esc(catalogError)}<button data-action="refresh">Retry connection</button></div>` : ''}${kind === 'permission' ? '<div class="chat-menu-note">Applies to this session. Your agent enforces its own policies and project rules.</div>' : ''}`;
    menu.classList.remove('hidden');
    paneEl.querySelector(`[data-menu="${kind}"]`)?.setAttribute('aria-expanded', 'true');
    menu.querySelector('[aria-checked="true"]')?.focus();
  }
  function outside(event) { if (!paneEl.contains(event.target) || (!menu.contains(event.target) && !event.target.closest('[data-menu]'))) closeMenu(); }
  document.addEventListener('pointerdown', outside);

  function renderAttachments() {
    $('.chat-attachments').innerHTML = attachments.map((a, index) => `<div class="chat-attachment"><img src="${esc(a.dataUrl)}" alt="${esc(a.name)}"><span>${esc(a.name)}</span><button data-remove="${index}" aria-label="Remove image">×</button></div>`).join('');
    syncControls();
  }
  function renderRequests() {
    const area = $('.chat-requests');
    // Keep existing forms and typed answers intact when another request arrives.
    for (const card of area.children) if (!requests.has(card.dataset.requestId)) card.remove();
    for (const request of requests.values()) {
      if ([...area.children].some(c => c.dataset.requestId === request.id)) continue;
      const card = document.createElement('form'); card.className = 'chat-request'; card.dataset.requestId = request.id;
      card.innerHTML = `<div class="chat-request-heading">${icon('shield')}<strong>${esc(request.title)}</strong><span>Your decision</span></div><p>${esc(request.description)}</p>`;
      let supported = true;
      if (request.kind === 'question') {
        for (const q of request.questions || []) {
          const field = document.createElement('fieldset'); field.dataset.question = q.id;
          field.innerHTML = `<legend>${esc(q.question)}</legend>${(q.options || []).map(o => `<label class="chat-answer-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${esc(q.id)}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('')}<input class="chat-answer-text" type="${q.isSecret ? 'password' : 'text'}" aria-label="Your answer" placeholder="${q.options?.length ? 'Or write your own answer…' : 'Your answer…'}">`;
          card.appendChild(field);
        }
      } else if (request.kind === 'elicitation') {
        const schema = request.schema;
        supported = schema?.type === 'object' && Object.values(schema.properties || {}).every(p => ['string', 'boolean', 'number', 'integer'].includes(p.type));
        if (supported) for (const [key, spec] of Object.entries(schema.properties || {})) {
          const label = document.createElement('label'); label.className = 'chat-schema-field';
          const text = document.createElement('span'); text.textContent = spec.title || key; label.appendChild(text);
          const field = document.createElement(spec.enum ? 'select' : 'input'); field.dataset.property = key; field.dataset.type = spec.type;
          if (spec.enum) for (const value of spec.enum) { const o = document.createElement('option'); o.value = value; o.textContent = value; field.appendChild(o); }
          else field.type = spec.type === 'boolean' ? 'checkbox' : spec.type === 'string' ? 'text' : 'number';
          if (spec.type === 'integer') field.step = '1';
          field.required = schema.required?.includes(key) && spec.type !== 'boolean';
          label.appendChild(field); card.appendChild(label);
        }
        else { const note = document.createElement('p'); note.textContent = 'This agent requests an unsupported form. You can decline it and continue in the official CLI.'; card.appendChild(note); }
      } else if (request.details) {
        const pre = document.createElement('pre'); pre.textContent = request.details; card.appendChild(pre);
      }
      const actions = document.createElement('div'); actions.className = 'chat-request-actions';
      actions.innerHTML = `<button type="button" data-decision="deny">Decline</button>${request.allowSession ? '<button type="button" data-decision="session">Allow for session</button>' : ''}${supported ? `<button type="submit" class="chat-approve">${request.kind === 'question' ? 'Send answer' : 'Allow once'}</button>` : ''}`;
      card.appendChild(actions);
      const respond = async decision => {
        const answers = {}, content = {};
        for (const field of card.querySelectorAll('[data-question]')) {
          const custom = field.querySelector('.chat-answer-text').value.trim();
          const values = custom ? [custom] : [...field.querySelectorAll('input:checked')].map(i => i.value);
          if (decision === 'allow' && !values.length) { field.querySelector('.chat-answer-text').focus(); return; }
          answers[field.dataset.question] = { answers: values };
        }
        for (const field of card.querySelectorAll('[data-property]')) content[field.dataset.property] = field.dataset.type === 'boolean' ? field.checked : ['number', 'integer'].includes(field.dataset.type) ? Number(field.value) : field.value;
        card.querySelectorAll('button').forEach(b => b.disabled = true);
        try { await invoke('chat:reply', { sessionId: id, requestId: request.id, answer: { decision, answers, content } }); }
        catch (err) { error(err.message); card.querySelectorAll('button').forEach(b => b.disabled = false); }
      };
      card.addEventListener('submit', e => { e.preventDefault(); respond('allow'); });
      card.querySelectorAll('[data-decision]').forEach(b => b.addEventListener('click', () => respond(b.dataset.decision)));
      area.appendChild(card);
    }
    syncControls();
  }
  async function send() {
    if (!ready || settingsBusy) return;
    if (busy) { try { await invoke('chat:stop', { sessionId: id }); } catch (err) { error(err.message); } return; }
    const text = input.value.trim(); if (!text && !attachments.length) return;
    const images = attachments;
    // Lock synchronously so a double Enter cannot submit twice before IPC replies.
    doc.status = 'working'; startedAt = Date.now(); closeMenu(); syncControls(); error('');
    try {
      await invoke('chat:send', { sessionId: id, text, attachments: images });
      if (input.value.trim() === text) { input.value = ''; preferences.removeItem(draftKey); }
      attachments = []; renderAttachments(); resize(); atBottom = true; schedule();
      if (session.title === 'New chat' || session.title === session.directory || session.title === session.directory.replace(require('os').homedir(), '~')) {
        session.title = text.replace(/\s+/g, ' ').slice(0, 48) || 'Image conversation'; persistSession(session); app.refreshLayout();
      }
    } catch (err) { doc.status = 'error'; error(err.message); syncControls(); }
  }
  paneEl.addEventListener('click', async event => {
    const button = event.target.closest('button');
    const link = event.target.closest('.chat-entry-body a');
    if (link) { event.preventDefault(); try { await invoke('chat:open-link', { url: link.href }); } catch (err) { error(err.message); } return; }
    if (!button) return;
    if (button.dataset.prompt) { input.value = button.dataset.prompt; resize(); syncControls(); input.focus(); }
    if (button.dataset.menu) { currentMenu === button.dataset.menu ? closeMenu() : openMenu(button.dataset.menu); }
    if ('option' in button.dataset) {
      const value = button.dataset.option;
      if (currentMenu === 'provider') await configure({ provider: value, model: '', effort: '', permissionMode: 'default' });
      else await configure(currentMenu === 'permission' ? { permissionMode: value } : currentMenu === 'model' ? { model: value, effort: '' } : { effort: value });
    }
    if ('remove' in button.dataset) { attachments.splice(Number(button.dataset.remove), 1); renderAttachments(); }
    if (button.dataset.copy) {
      const text = button.dataset.copy === 'code' ? button.parentElement.querySelector('code')?.textContent : doc.entries.find(e => e.id === button.closest('[data-entry-id]').dataset.entryId)?.text;
      require('electron').clipboard.writeText(text || ''); button.title = 'Copied'; if (button.dataset.copy === 'code') { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500); }
    }
    if (button.dataset.action === 'send') send();
    if (button.dataset.action === 'bottom') toBottom();
    if (button.dataset.action === 'close-menu') { closeMenu(); input.focus(); }
    if (button.dataset.action === 'refresh') { if (catalogError) error(catalogError); refreshCatalog(); }
    if (button.dataset.action === 'retry') { const last = [...doc.entries].reverse().find(e => e.kind === 'user'); if (last) { input.value = last.text; attachments = last.attachments || []; renderAttachments(); resize(); input.focus(); syncControls(); } }
    if (button.dataset.action === 'attach') {
      try { const picked = await invoke('chat:pick-images'); if (attachments.length + picked.length > 4) throw new Error('Attach up to four images.'); attachments.push(...picked); renderAttachments(); }
      catch (err) { error(err.message); }
    }
  });
  paneEl.addEventListener('keydown', event => {
    if (event.key === 'Escape' && currentMenu) { event.preventDefault(); event.stopPropagation(); closeMenu(); input.focus(); }
    if (event.target.closest('.chat-menu') && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const options = [...menu.querySelectorAll('.chat-menu-option')]; const index = options.indexOf(document.activeElement); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
    }
  });
  input.addEventListener('input', () => { preferences.setItem(draftKey, input.value); resize(); syncControls(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy) send(); } });
  input.addEventListener('paste', async event => {
    const files = [...(event.clipboardData?.files || [])].filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!files.length) return;
    event.preventDefault();
    if (attachments.length + files.length > 4 || files.some(f => f.size > 10 * 1024 * 1024)) { error('Attach up to four images, at most 10 MB each.'); return; }
    for (const file of files) {
      const reader = new FileReader(); reader.onload = () => { if (!disposed && attachments.length < 4) { attachments.push({ name: file.name, mime: file.type, dataUrl: reader.result }); renderAttachments(); } }; reader.readAsDataURL(file);
    }
  });
  scroll.addEventListener('scroll', () => { atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90; $('.chat-jump').classList.toggle('hidden', atBottom); });
  const ticker = setInterval(() => { if (busy) $('.chat-elapsed').textContent = `${Math.floor((Date.now() - startedAt) / 1000)}s`; }, 1000);
  invoke('chat:open', { sessionId: id }).then(snapshot => {
    if (disposed) return;
    doc = snapshot; ready = true; doc.entries.forEach(e => dirty.add(e.id));
    doc.pending.forEach(r => requests.set(r.id, r)); renderRequests();
    for (const event of buffered) apply(event); buffered.length = 0;
    error(doc.error); schedule(); resize(); refreshCatalog();
  }).catch(err => error(err.message));
  return runtime;
}
module.exports = { createChatPane };
