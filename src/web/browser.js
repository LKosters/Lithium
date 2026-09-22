const app = require('../renderer/app');
const { shell } = require('./electron');
function initBrowser() {
  app.openBrowserUrl = url => {
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) parsed.hostname = location.hostname;
    shell.openExternal(parsed.href);
  };
  app.openBrowser = () => window.alert('Open the project’s network URL in a new tab. Its development server must listen on the network interface.');
  app.closeBrowser = () => {};
  app.isBrowserOpen = () => false;
}
module.exports = { initBrowser, initBrowserTools() {} };
