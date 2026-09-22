const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createHash } = require('crypto');
const { spawn } = require('child_process');
const { compareVersions, selectAsset, trustedURL, latestRelease, download, verifyFile } = require('../src/main/update/release');
const { installationPath, validateArchiveEntries, validateBundle } = require('../src/main/update/mac');
const { createManifest } = require('../scripts/update-manifest');
function root(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lithium-updater-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function asset(bytes, fields = {}) { return { platform: 'darwin', arch: 'arm64', name: 'Lithium-1.2.3-mac-arm64.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://github.com/lkosters/lithium/releases/download/v1.2.3/update.zip', ...fields }; }

test('updates select exact OS/architecture and reject malformed versions, metadata and URLs', () => {
  assert.equal(compareVersions('1.9.9', '1.10.0'), 1); assert.equal(compareVersions('2.0.0', '1.9.9'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0); assert.throws(() => compareVersions('1.2.3', '1.2.4-beta'));
  const arm = asset(Buffer.from('app')), intel = { ...arm, arch: 'x64', name: 'Lithium-1.2.3-mac-x64.zip' };
  const manifest = { schemaVersion: 1, version: '1.2.3', assets: [arm, intel] };
  assert.equal(selectAsset(manifest, '1.2.3', 'darwin', 'x64').name, intel.name);
  assert.throws(() => selectAsset(manifest, '1.2.3', 'win32', 'x64'));
  assert.throws(() => selectAsset({ ...manifest, assets: [{ ...arm, name: '../app.zip' }] }, '1.2.3', 'darwin', 'arm64'));
  assert.throws(() => selectAsset({ ...manifest, assets: [arm, arm] }, '1.2.3', 'darwin', 'arm64'));
  assert.throws(() => trustedURL('http://github.com/lkosters/lithium'));
  assert.throws(() => trustedURL('https://github.com.evil.test/app'));
  assert.throws(() => trustedURL('https://user:pass@github.com/app'));
});

test('release metadata stays bound to Lithium and old releases offer a manual fallback', async () => {
  const a = asset(Buffer.from('zip'));
  const githubAsset = name => ({ name, state: 'uploaded', browser_download_url: `https://github.com/lkosters/lithium/releases/download/v1.2.3/${name}` });
  const release = { tag_name: 'v1.2.3', assets: [githubAsset('lithium-update.json'), githubAsset(a.name)] };
  const get = async url => url.includes('api.github.com') ? release : { schemaVersion: 1, version: '1.2.3', assets: [a] };
  const result = await latestRelease('1.2.2', 'darwin', 'arm64', get);
  assert.equal(result.asset.sha256, a.sha256);
  release.assets[1].browser_download_url = 'https://github.com/other/project/releases/download/v1.2.3/app.zip';
  await assert.rejects(latestRelease('1.2.2', 'darwin', 'arm64', get), /outside/);
  release.assets = [];
  assert.match((await latestRelease('1.2.2', 'darwin', 'arm64', get)).manualReason, /manual/);
});

test('download checks size and SHA-256, cleans partial files, and rechecks before install', async t => {
  const dir = root(t), bytes = Buffer.from('A complete update'), a = asset(bytes), progress = [];
  const file = await download(a, dir, n => progress.push(n), async () => Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]));
  assert.equal(progress.at(-1), 100); assert.equal(fs.readFileSync(file, 'utf8'), bytes.toString());
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 'x'));
  await assert.rejects(verifyFile(file, a), /checksum/);
  await assert.rejects(download(a, dir, null, async () => Readable.from([Buffer.from('short')])), /incomplete/);
  assert.equal(fs.existsSync(`${file}.partial`), false);
  await assert.rejects(download(a, dir, null, async () => Readable.from([Buffer.alloc(bytes.length + 1)])), /exceeds/);
  await assert.rejects(download(a, dir, null, async () => Readable.from([Buffer.alloc(bytes.length)])), /checksum/);
});

test('manifest generation includes both Mac architectures and fails on missing release artifacts', async t => {
  const dir = root(t);
  for (const name of ['mac-arm64.zip', 'mac-x64.zip', 'win-x64.exe', 'linux-x64.AppImage']) fs.writeFileSync(path.join(dir, `Lithium-1.2.3-${name}`), name);
  const manifest = await createManifest(dir, '1.2.3'); assert.equal(manifest.assets.length, 4);
  for (const a of manifest.assets) await verifyFile(path.join(dir, a.name), a);
  fs.unlinkSync(path.join(dir, 'Lithium-1.2.3-mac-x64.zip'));
  await assert.rejects(createManifest(dir, '1.2.3'));
});

test('Mac preflight rejects unsafe archives, mounted disk images, and wrong application identity', async t => {
  validateArchiveEntries('Lithium.app/\nLithium.app/Contents/Info.plist\n');
  for (const entries of ['../other', '/Applications/X.app', 'Lithium.app/../../other', 'Other.app/']) assert.throws(() => validateArchiveEntries(entries));
  assert.throws(() => installationPath('/Volumes/Lithium/Lithium.app/Contents/MacOS/Lithium'), /Applications/);
  const dir = path.join(root(t), 'Lithium.app'); fs.mkdirSync(path.join(dir, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents/MacOS/Lithium'), 'app', { mode: 0o755 });
  const run = async (_file, args) => ({ stdout: { CFBundleIdentifier: 'com.lithium.app', CFBundleShortVersionString: '1.2.3', CFBundleExecutable: 'Lithium' }[args[1]] });
  await validateBundle(dir, '1.2.3', run); await assert.rejects(validateBundle(dir, '1.2.4', run), /match/);
});

async function runHelper(t, { failSwap = false, failLaunch = false, aliveParent = false } = {}) {
  const dir = root(t), target = path.join(dir, "Lithium's $(touch PWNED).app"), staged = path.join(dir, 'staged.app'), previous = path.join(dir, 'previous.app');
  for (const [file, value] of [[target, 'old'], [staged, 'new']]) { fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'version'), value); }
  const health = path.join(dir, 'health'), result = path.join(dir, 'result');
  const open = path.join(dir, 'fake-open'); fs.writeFileSync(open, '#!/bin/sh\nif [ "$LITHIUM_TEST_FAIL_LAUNCH" = 1 ] && [ "$(cat "$2/version")" = new ]; then exit 1; fi\n: > "$LITHIUM_TEST_HEALTH"\n', { mode: 0o700 });
  const mv = path.join(dir, 'fake-mv'); fs.writeFileSync(mv, '#!/bin/sh\nif [ "$LITHIUM_TEST_FAIL_SWAP" = 1 ] && [ "$1" = "$LITHIUM_TEST_STAGE" ]; then exit 1; fi\nexec /bin/mv "$@"\n', { mode: 0o700 });
  const script = path.join(dir, 'helper.sh');
  fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, '../src/main/update/install-mac.sh'), 'utf8').replaceAll('/usr/bin/open', '"$LITHIUM_TEST_OPEN"').replaceAll('/bin/mv', '"$LITHIUM_TEST_MV"'));
  let parent;
  if (aliveParent) parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => parent?.kill());
  const child = spawn('/bin/sh', [script, String(parent?.pid || 99999999), target, staged, previous, result, health, 'test-token'], { cwd: dir, env: { ...process.env, LITHIUM_TEST_OPEN: open, LITHIUM_TEST_MV: mv, LITHIUM_TEST_STAGE: staged, LITHIUM_TEST_HEALTH: health, LITHIUM_TEST_FAIL_SWAP: failSwap ? '1' : '', LITHIUM_TEST_FAIL_LAUNCH: failLaunch ? '1' : '' }, stdio: 'pipe' });
  const finished = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  if (parent) {
    for (let i = 0; i < 100 && !fs.existsSync(result); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'old');
    assert.equal(fs.existsSync(previous), false); parent.kill();
  }
  const code = await finished;
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
  assert.equal(fs.existsSync(`${target}.update-lock`), false);
  return { target, previous, result: fs.readFileSync(result, 'utf8').trim(), code };
}
test('detached helper waits for the app, replaces it, and keeps the previous version; paths are literal', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  const r = await runHelper(t, { aliveParent: true }); assert.equal(r.code, 0); assert.equal(r.result, 'succeeded');
  assert.equal(fs.readFileSync(path.join(r.target, 'version'), 'utf8'), 'new'); assert.equal(fs.readFileSync(path.join(r.previous, 'version'), 'utf8'), 'old');
});
test('helper rolls back when the replacement cannot be moved or the new app cannot launch', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  for (const failure of [{ failSwap: true }, { failLaunch: true }]) {
    const r = await runHelper(t, failure); assert.equal(r.code, 1); assert.equal(r.result, 'rolled-back'); assert.equal(fs.readFileSync(path.join(r.target, 'version'), 'utf8'), 'old');
  }
});
