const bridge = require('./electron');
async function boot() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let linkCode = fragment.get('code');
  if (fragment.has('code')) {
    fragment.delete('code');
    const remaining = fragment.toString();
    history.replaceState(null, '', location.pathname + location.search + (remaining ? `#${remaining}` : ''));
  }
  document.body.classList.add('web-loading');
  const login = document.createElement('div'); login.id = 'web-login';
  login.innerHTML = `<form><h1>Lithium</h1><p>Connect to the desktop app</p><label for="web-access-code">Access code</label><input id="web-access-code" type="password" autocomplete="off" required placeholder="Copy from Settings → Web access" /><button type="submit">Connect</button><p role="status"></p></form>`;
  document.body.append(login);
  const status = login.querySelector('[role="status"]');
  async function launch() {
    await bridge.connect();
    // A normal browser cannot host Electron webviews. Preview opens in a new tab.
    require('../renderer');
    document.querySelector('[data-settings-tab="data"]').hidden = true;
    document.querySelector('.settings-row-update').hidden = true;
    document.body.classList.remove('web-loading');
    document.body.classList.add('web-client');
    login.remove();
  }
  login.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const button = login.querySelector('button'); button.disabled = true;
    try { await bridge.request('/api/login', { code: login.querySelector('input').value.trim() }); await launch(); }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  const connectButton = login.querySelector('button');
  connectButton.disabled = true;
  try {
    if ((await bridge.request('/api/auth')).authorized) await launch();
    else if (linkCode) {
      status.textContent = 'Connecting…';
      await bridge.request('/api/login', { code: linkCode });
      await launch();
    }
  }
  catch (error) { status.textContent = error.message; }
  finally { linkCode = null; connectButton.disabled = false; }
}
boot().catch(error => bridge.showError(error.message));
