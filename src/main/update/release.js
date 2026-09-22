const https = require('https');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const REPOSITORY = 'lkosters/lithium';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024;
function versionParts(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Unsupported release version.');
  return version.split('.').map(Number);
}
function compareVersions(current, latest) {
  const a = versionParts(current), b = versionParts(latest);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i] ? 1 : -1;
  return 0;
}
function trustedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('Untrusted update download URL.');
  return url;
}
function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = trustedURL(url);
    const req = https.get(parsed, { headers: { 'User-Agent': 'Lithium-Updater', Accept: 'application/vnd.github+json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects >= 5) return reject(new Error('Too many update download redirects.'));
        try { resolve(request(new URL(res.headers.location, parsed).href, redirects + 1)); } catch (error) { reject(error); }
      } else if (res.statusCode !== 200) { res.resume(); reject(new Error(`Update server returned HTTP ${res.statusCode}.`)); }
      else resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Update download timed out.')));
    req.on('error', reject);
  });
}
async function fetchJson(url, limit = 2 * 1024 * 1024) {
  const res = await request(url); let size = 0; const chunks = [];
  for await (const chunk of res) { size += chunk.length; if (size > limit) { res.destroy(); throw new Error('Update metadata is too large.'); } chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function assetURL(release, name) {
  const asset = release.assets?.find(a => a.name === name);
  if (!asset || asset.state !== 'uploaded') throw new Error(`Release is missing ${name}.`);
  const url = trustedURL(asset.browser_download_url);
  if (url.hostname !== 'github.com' || !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) throw new Error('Release asset is outside the Lithium repository.');
  return url.href;
}
function selectAsset(manifest, version, platform, arch) {
  if (manifest?.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.assets)) throw new Error('Invalid update manifest.');
  versionParts(version);
  const matches = manifest.assets.filter(a => a.platform === platform && a.arch === arch);
  if (matches.length !== 1) throw new Error(`No update package is available for ${platform}/${arch}.`);
  const a = matches[0];
  const extension = { darwin: 'zip', win32: 'exe', linux: 'AppImage' }[platform];
  if (!extension || typeof a.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(a.name) || !a.name.endsWith(`.${extension}`) || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > MAX_DOWNLOAD) throw new Error('Invalid update package metadata.');
  return { ...a };
}
async function latestRelease(current, platform, arch, json = fetchJson) {
  const release = await json(`https://api.github.com/repos/${REPOSITORY}/releases/latest`);
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (release.draft || release.prerelease) throw new Error('Only stable published releases can be installed.');
  const result = { currentVersion: current, latestVersion: version, updateAvailable: compareVersions(current, version) > 0, releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` };
  if (!result.updateAvailable) return result;
  if (!release.assets?.some(a => a.name === 'lithium-update.json')) return { ...result, manualReason: 'This older release only has a manual installer. Open the release page to install it.' };
  const manifest = await json(assetURL(release, 'lithium-update.json'));
  const asset = selectAsset(manifest, version, platform, arch);
  return { ...result, asset: { ...asset, url: assetURL(release, asset.name) } };
}
async function verifyFile(file, asset) {
  const stat = await fs.promises.stat(file);
  if (stat.size !== asset.size) throw new Error('The update download is incomplete. Please download it again.');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw new Error('Update checksum mismatch. The update was not installed.');
}
async function download(asset, directory, onProgress, get = request) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, asset.name), partial = `${file}.partial`;
  let received = 0;
  try {
    const res = await get(asset.url);
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > asset.size) return callback(new Error('Update exceeds the expected size.'));
      onProgress?.(Math.floor(received / asset.size * 100)); callback(null, chunk);
    } });
    await pipeline(res, meter, fs.createWriteStream(partial, { mode: 0o600 }));
    await verifyFile(partial, asset); await fs.promises.rename(partial, file); return file;
  } catch (error) { fs.rmSync(partial, { force: true }); throw error; }
}
module.exports = { REPOSITORY, RELEASES_URL, compareVersions, selectAsset, latestRelease, verifyFile, download, trustedURL };
