const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
async function createManifest(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release tag must be vX.Y.Z.');
  const assets = [];
  const targets = [['mac', 'darwin', 'arm64', 'zip'], ['mac', 'darwin', 'x64', 'zip'], ['win', 'win32', 'x64', 'exe'], ['linux', 'linux', 'x64', 'AppImage']];
  for (const [os, platform, arch, ext] of targets) {
    const name = `Lithium-${version}-${os}-${arch}.${ext}`, file = path.join(directory, name);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    assets.push({ platform, arch, name, size: fs.statSync(file).size, sha256: hash.digest('hex') });
  }
  const manifest = { schemaVersion: 1, version, assets };
  fs.writeFileSync(path.join(directory, 'lithium-update.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (require.main === module) createManifest(process.argv[2], (process.argv[3] || '').replace(/^v/, '')).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createManifest };
