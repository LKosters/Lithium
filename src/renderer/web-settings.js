const QRCode = require('qrcode');

function createWebSettings(ipc, overlay) {
  const nav = document.createElement('button');
  nav.className = 'settings-nav-item'; nav.dataset.settingsTab = 'web';
  nav.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.5"/><path d="M3 12h18" stroke="currentColor" stroke-width="1.5"/></svg><span>Web access</span>';
  overlay.querySelector('.settings-nav').append(nav);
  const panel = document.createElement('div'); panel.className = 'settings-panel'; panel.dataset.settingsPanel = 'web';
  panel.innerHTML = `<h2 class="settings-panel-title">Web access</h2>
    <p class="settings-group-hint">Use Lithium from another browser on your local network or Tailscale network. Chats, terminals and project files run on this computer. Keep Lithium running while connected.</p>
    <div class="settings-group">
      <div class="settings-row"><label class="settings-row-label" for="web-port"><span class="settings-row-name">Port</span><span class="settings-row-desc">Allow this port through the host firewall if needed.</span></label><input id="web-port" type="number" min="1024" max="65535" value="3210" style="width:100px" /></div>
      <div class="settings-row"><span class="settings-row-label"><span class="settings-row-name">Web version</span><span class="settings-row-desc" data-web-status role="status">Stopped</span></span><button class="settings-btn-sm settings-btn-accent" data-web-toggle>Start web version</button></div>
    </div>
    <div data-web-details class="hidden"><h3 class="settings-group-title">Connect a device</h3><p class="settings-group-hint">Scan a QR code to connect automatically, or open an address and enter the access code. QR codes include access to your agents and projects.</p><div class="settings-group" data-web-addresses></div>
      <div class="web-access-key">
        <label class="settings-row-name" for="web-access-key">Access code</label>
        <div class="web-access-key-control">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="8" cy="15" r="5" stroke="currentColor" stroke-width="1.5"/><path d="m11.5 11.5 9-9M17 6l3 3M14 9l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <input id="web-access-key" data-web-code type="text" readonly spellcheck="false" autocomplete="off" aria-describedby="web-access-key-hint" />
          <button class="settings-btn-sm" data-web-copy>Copy code</button>
        </div>
        <p id="web-access-key-hint" class="settings-row-desc">For manual sign-in. Scanning a QR code signs you in automatically.</p>
      </div>
      <p class="settings-group-hint">Local network access uses HTTP. Tailscale encrypts traffic between your devices; both devices must be connected and your Tailscale access rules must allow this port. Stopping the web version disconnects browsers and invalidates the code. Starting again creates a new code.</p>
    </div>`;
  overlay.querySelector('.settings-main').append(panel);
  const $ = selector => panel.querySelector(selector);
  let running = false;
  function render(status) {
    running = status.running;
    $('#web-port').value = status.port; $('#web-port').disabled = running;
    $('[data-web-status]').textContent = status.error || (running ? 'Running · available on the addresses below' : 'Stopped · starts only when you enable it');
    $('[data-web-toggle]').textContent = running ? 'Stop web version' : 'Start web version';
    $('[data-web-details]').classList.toggle('hidden', !running);
    $('[data-web-code]').value = status.code || '';
    const addresses = $('[data-web-addresses]'); addresses.replaceChildren();
    for (const [index, item] of status.addresses.entries()) {
      const wrapper = document.createElement('div'); wrapper.className = 'web-address';
      const row = document.createElement('div'); row.className = 'settings-row';
      const label = document.createElement('span'); label.textContent = item.label;
      const link = document.createElement('a'); link.textContent = item.url; link.href = item.url;
      link.addEventListener('click', e => { e.preventDefault(); require('electron').shell.openExternal(item.url); });
      const qrId = `web-address-qr-${index}`;
      const toggle = document.createElement('button'); toggle.className = 'settings-btn-sm web-qr-toggle';
      toggle.type = 'button'; toggle.textContent = 'Show QR'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', qrId);
      const qr = document.createElement('div'); qr.id = qrId; qr.className = 'web-address-qr hidden';
      const image = document.createElement('img'); image.alt = `QR code for ${item.label}: ${item.url}`;
      const message = document.createElement('span'); message.setAttribute('role', 'status');
      qr.append(image, message);
      toggle.addEventListener('click', async () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Hide QR' : 'Show QR';
        qr.classList.toggle('hidden', !open);
        if (!open || image.src) return;
        toggle.disabled = true; message.textContent = 'Generating QR code…';
        try {
          const qrUrl = new URL(item.url);
          qrUrl.hash = new URLSearchParams({ code: status.code }).toString();
          image.src = await QRCode.toDataURL(qrUrl.href, { width: 220, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#17140e', light: '#ffffff' } });
          message.textContent = '';
        } catch (error) {
          message.textContent = `Could not generate QR code: ${error.message}`;
        } finally { toggle.disabled = false; }
      });
      const actions = document.createElement('span'); actions.className = 'web-address-actions'; actions.append(link, toggle);
      row.append(label, actions); wrapper.append(row, qr); addresses.append(wrapper);
    }
  }
  async function load() {
    if (ipc.isWeb) {
      $('[data-web-status]').textContent = 'Connected. Manage web access in the desktop app.';
      $('[data-web-toggle]').disabled = true; $('#web-port').disabled = true; return;
    }
    try {
      const status = await ipc.invoke('web:status');
      if (!status.running) status.port = await ipc.invoke('config:get', 'webPort') || status.port;
      render(status);
    } catch (error) { $('[data-web-status]').textContent = error.message; }
  }
  $('[data-web-toggle]').addEventListener('click', async () => {
    const button = $('[data-web-toggle]'); button.disabled = true;
    try { render(await ipc.invoke(running ? 'web:stop' : 'web:start', { port: Number($('#web-port').value) })); }
    catch (error) { $('[data-web-status]').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('[data-web-code]').addEventListener('focus', event => event.target.select());
  $('[data-web-copy]').addEventListener('click', () => {
    require('electron').clipboard.writeText($('[data-web-code]').value);
    $('[data-web-copy]').textContent = 'Copied';
    setTimeout(() => { $('[data-web-copy]').textContent = 'Copy code'; }, 1500);
  });
  return { load };
}
module.exports = { createWebSettings };
