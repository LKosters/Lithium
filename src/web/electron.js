const listeners = new Map();
let clientId;
let sendQueue = Promise.resolve();
let eventSource;
const connection = { home: '' };
function showError(message) {
  let banner = document.querySelector('#web-connection');
  if (!banner) { banner = document.createElement('div'); banner.id = 'web-connection'; banner.setAttribute('role', 'status'); document.body.append(banner); }
  banner.textContent = message;
  banner.hidden = !message;
}
async function request(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    if ([401, 409].includes(response.status)) showError(`${result.error} Reload to reconnect.`);
    throw new Error(result.error || 'Request failed.');
  }
  return result;
}
function rpc(kind, channel, input) {
  return request(`/api/rpc?client=${encodeURIComponent(clientId)}`, { kind, channel, input }).then(result => result.value);
}
function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}
function writeText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
}
function pickImages() {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif'; input.multiple = true;
    input.addEventListener('cancel', () => resolve({ ok: true, value: [] }), { once: true });
    input.addEventListener('change', async () => {
      try {
        const files = [...input.files];
        if (files.length > 4 || files.some(file => file.size > 10 * 1024 * 1024)) throw new Error('Attach up to four images, at most 10 MB each.');
        const value = await Promise.all(files.map(file => new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read image.'));
          reader.onload = () => resolve({ name: file.name, mime: file.type, dataUrl: reader.result }); reader.readAsDataURL(file);
        })));
        resolve({ ok: true, value });
      } catch (error) { resolve({ ok: false, error: error.message }); }
    }, { once: true });
    input.click();
  });
}
const ipcRenderer = {
  isWeb: true,
  on(channel, fn) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); return this; },
  removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return this; },
  sendSync(channel) {
    if (channel !== 'preferences:bootstrap') throw new Error('Unsupported synchronous operation.');
    const preferences = {};
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (require('../shared/preferences').preferenceKey(key)) preferences[key] = localStorage.getItem(key); }
    return { ok: true, value: { preferences, config: { currentDir: localStorage.getItem('currentDir') }, layout: JSON.parse(localStorage.getItem('web-layout') || 'null') } };
  },
  send(channel, input) {
    if (channel === 'preferences:set') return; // Browser drafts and appearance stay on this device.
    if (channel === 'layout:save') { localStorage.setItem('web-layout', JSON.stringify(input)); return; }
    if (channel === 'config:set') { if (input.value === null) localStorage.removeItem(input.key); else localStorage.setItem(input.key, input.value); return; }
    sendQueue = sendQueue.then(() => rpc('send', channel, input)).catch(error => showError(error.message));
  },
  async invoke(channel, input) {
    if (channel === 'config:get') return localStorage.getItem(input);
    if (channel === 'config:resolve-projects-dir' && localStorage.getItem('projectsDir')) return localStorage.getItem('projectsDir');
    if (channel === 'layout:load') return JSON.parse(localStorage.getItem('web-layout') || 'null');
    if (channel === 'media:now-playing') return null;
    if (channel === 'media:control') return false;
    if (channel === 'chat:pick-images') return pickImages();
    if (channel === 'chat:open-link') { openExternal(input.url); return { ok: true }; }
    if (channel === 'directory:pick') {
      input = window.prompt('Absolute project folder path on the computer running Lithium:', localStorage.getItem('currentDir') || connection.home);
      if (!input) return null;
    }
    await sendQueue;
    return rpc('invoke', channel, input);
  },
};
async function connect() {
  const previous = sessionStorage.getItem('lithium-web-client');
  const result = await request('/api/connect', { previous });
  clientId = result.id; connection.home = result.home;
  sessionStorage.setItem('lithium-web-client', clientId);
  return new Promise((resolve, reject) => {
    eventSource = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
    let opened = false;
    eventSource.onopen = () => { if (opened) { location.reload(); return; } opened = true; showError(''); resolve(); };
    eventSource.onerror = () => {
      showError('Connection lost. Reconnecting… Keep Lithium running on the host.');
      if (!opened) { eventSource.close(); reject(new Error('Could not connect to the host. Reload to try again.')); }
    };
    eventSource.onmessage = event => {
      const { channel, payload } = JSON.parse(event.data);
      for (const fn of listeners.get(channel) || []) fn({}, payload);
    };
  });
}
module.exports = { ipcRenderer, shell: { openExternal }, clipboard: { writeText }, connection, request, connect, showError };
