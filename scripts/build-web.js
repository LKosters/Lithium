const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
const web = file => path.join(root, 'src/web', file);
const icons = Object.fromEntries(fs.readdirSync(path.join(root, 'src/assets/framework-icons')).map(file => [file, fs.readFileSync(path.join(root, 'src/assets/framework-icons', file), 'utf8')]));
esbuild.build({
  entryPoints: [web('entry.js')], outfile: web('app.bundle.js'), bundle: true,
  platform: 'browser', target: ['chrome110', 'safari16'], minify: true,
  define: { __dirname: '"/src/renderer"' },
  plugins: [{ name: 'desktop-adapters', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: web('electron.js') }));
    build.onResolve({ filter: /^\.\/renderer\/browser$/ }, () => ({ path: web('browser.js') }));
    build.onResolve({ filter: /^(os|fs|path)$/ }, args => ({ path: args.path, namespace: 'browser-adapter' }));
    build.onLoad({ filter: /.*/, namespace: 'browser-adapter' }, args => ({ contents: {
      os: `exports.homedir = () => require(${JSON.stringify(web('electron.js'))}).connection.home;`,
      path: 'exports.join = (...parts) => parts.join("/");',
      fs: `const icons = ${JSON.stringify(icons)}; exports.readFileSync = file => { const icon = icons[file.split('/').pop()]; if (!icon) throw new Error('Unknown asset'); return icon; };`,
    }[args.path], resolveDir: root }));
  } }],
}).catch(error => { console.error(error); process.exit(1); });
