const app = require('./app');
const { state, getAllLeaves } = require('./state');

function initialize() {
  const phone = window.matchMedia('(max-width: 700px)');
  const sidebar = document.querySelector('#sidebar');
  let screen = state.currentDir ? 'chats' : 'projects';
  let lastSession;
  const svg = path => `<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const icons = {
    projects: svg('<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>'),
    chats: svg('<path d="M4 4h16v13H9l-5 4Z"/><path d="M8 8h8M8 12h5"/>'),
    settings: svg('<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>'),
  };
  const bar = document.createElement('nav'); bar.id = 'mobile-tab-bar'; bar.setAttribute('aria-label', 'Main navigation');
  for (const [name, label] of [['projects', 'Projects'], ['chats', 'Chats'], ['settings', 'Settings']]) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.mobileScreen = name;
    button.innerHTML = icons[name] + `<span>${label}</span>`;
    button.addEventListener('click', () => navigate(name)); bar.append(button);
  }
  document.body.append(bar);
  const back = document.createElement('button'); back.id = 'navigation-toggle'; back.type = 'button'; back.className = 'btn-icon';
  back.setAttribute('aria-label', 'Back to chats'); back.innerHTML = svg('<path d="m14 6-6 6 6 6"/>');
  back.addEventListener('click', () => navigate('chats'));
  const title = document.createElement('span'); title.id = 'mobile-screen-title';
  document.querySelector('.titlebar-left').prepend(back, title);
  const create = document.createElement('button'); create.type = 'button'; create.id = 'mobile-create'; create.className = 'btn-icon';
  create.innerHTML = svg('<path d="M12 5v14M5 12h14"/>');
  create.addEventListener('click', () => {
    if (screen === 'projects') document.querySelector('#btn-new-project').click();
    else if (!state.currentDir) navigate('projects');
    else { app.newSession(); navigate('conversation'); }
  });
  document.querySelector('.titlebar-right').append(create);

  function sync() {
    document.body.dataset.mobileScreen = screen;
    sidebar.inert = phone.matches && !['projects', 'chats'].includes(screen);
    const session = state.sessions.find(session => session.id === state.activeId);
    title.textContent = screen === 'conversation' ? session?.title || 'Chat' : screen[0].toUpperCase() + screen.slice(1);
    back.hidden = screen !== 'conversation';
    create.hidden = screen === 'settings';
    create.setAttribute('aria-label', screen === 'projects' ? 'New project' : state.currentDir ? 'New chat' : 'Choose a project');
    for (const button of bar.children) {
      const active = button.dataset.mobileScreen === (screen === 'conversation' ? 'chats' : screen);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    requestAnimationFrame(() => app.fitAllVisibleTerminals());
  }
  function navigate(next) {
    if (next === 'settings') require('./settings').openSettings();
    else { require('./settings').closeSettings(); require('./git').closeGit(); }
    screen = next; sync();
  }
  app.onSettingsOpen = () => { if (phone.matches) { screen = 'settings'; sync(); } };
  app.onSettingsClose = () => { if (screen === 'settings') { screen = state.activeId ? 'conversation' : 'chats'; sync(); } };
  sidebar.addEventListener('click', event => {
    if (!phone.matches) return;
    if (event.target.closest('.project-item[data-project-dir]') && !event.target.closest('.project-item-actions')) navigate('chats');
    if (event.target.closest('[data-session-id]') && !event.target.closest('button, input')) navigate('conversation');
    if (event.target.closest('#btn-new-session') && state.currentDir) navigate('conversation');
  });
  document.addEventListener('keydown', event => { if (phone.matches && event.key === 'Escape' && screen === 'conversation') navigate('chats'); });
  const changed = () => { sidebar.inert = false; sync(); };
  if (phone.addEventListener) phone.addEventListener('change', changed); else phone.addListener(changed);

  const chooser = document.createElement('select'); chooser.id = 'compact-pane-select'; chooser.setAttribute('aria-label', 'Active split pane');
  document.querySelector('#main').prepend(chooser);
  app.updateResponsivePanes = () => {
    const leaves = getAllLeaves(state.layout);
    chooser.replaceChildren(); chooser.hidden = leaves.length < 2;
    leaves.forEach((leaf, index) => {
      const option = document.createElement('option'); option.value = leaf.id;
      option.textContent = `${index + 1} · ${state.sessions.find(s => s.id === leaf.activeTab)?.title || 'Empty pane'}`;
      chooser.append(option);
    });
    chooser.value = state.focusedPaneId || '';
    if (state.activeId && state.activeId !== lastSession && screen !== 'settings') screen = 'conversation';
    lastSession = state.activeId; sync();
  };
  chooser.addEventListener('change', () => {
    state.focusedPaneId = chooser.value;
    const leaf = getAllLeaves(state.layout).find(leaf => leaf.id === chooser.value);
    const session = state.sessions.find(session => session.id === leaf?.activeTab);
    if (session?.directory && session.directory !== state.currentDir) app.setDirectory(session.directory);
    app.refreshLayout();
  });
  app.updateResponsivePanes();

  const viewport = window.visualViewport;
  const resize = () => {
    if (!viewport || viewport.scale !== 1) return;
    if (viewport.height < window.innerHeight - 1) {
      document.documentElement.style.setProperty('--visible-height', `${viewport.height}px`);
      document.documentElement.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
    } else {
      document.documentElement.style.removeProperty('--visible-height');
      document.documentElement.style.removeProperty('--viewport-top');
    }
  };
  window.addEventListener('resize', resize);
  viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize); resize();
}
module.exports = { initialize };
