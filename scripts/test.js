// Test native modules with the same Node ABI as the desktop app, on every OS.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.js')).sort().map(file => path.join(root, 'tests', file));
const result = spawnSync(require('electron'), ['--test', ...files], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
