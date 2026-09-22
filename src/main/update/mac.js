const fs = require('fs');
const disk = process.versions.electron ? require('original-fs') : fs;
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
function installationPath(executable) {
  const target = path.resolve(path.dirname(executable), '../..');
  if (!target.endsWith('.app') || !executable.startsWith(path.join(target, 'Contents', 'MacOS') + path.sep)) throw new Error('Run the installed Lithium app to install updates.');
  if (target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) throw new Error('Move Lithium to Applications once, then open that copy to use in-app updates.');
  fs.accessSync(path.dirname(target), fs.constants.W_OK);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Open the installed app directly to update it.');
  return target;
}
function validateArchiveEntries(text) {
  const entries = text.trim().split('\n');
  if (!entries.length || entries.some(name => !name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /[\x00-\x1f]/.test(name) || !(name === 'Lithium.app/' || name.startsWith('Lithium.app/') || name.startsWith('__MACOSX/')))) throw new Error('The update archive has an unexpected layout.');
}
async function validateBundle(bundle, version, runFile = run) {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const read = async key => (await runFile('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
  if (await read('CFBundleIdentifier') !== 'com.lithium.app' || await read('CFBundleShortVersionString') !== version) throw new Error('The update does not match Lithium or the selected release.');
  const executable = await read('CFBundleExecutable');
  if (!/^[A-Za-z0-9._-]+$/.test(executable)) throw new Error('Invalid update executable.');
  fs.accessSync(path.join(bundle, 'Contents', 'MacOS', executable), fs.constants.X_OK);
}
async function prepareMac(file, version, executable, workDir, runFile = run) {
  const target = installationPath(executable), token = randomUUID();
  const staged = path.join(path.dirname(target), `.Lithium-update-${token}.app`);
  const previous = path.join(path.dirname(target), `.Lithium-previous-${token}.app`);
  const extraction = path.join(workDir, `unpack-${token}`);
  try {
    const listing = await runFile('/usr/bin/unzip', ['-Z1', file], { maxBuffer: 32 * 1024 * 1024 });
    validateArchiveEntries(listing.stdout);
    fs.mkdirSync(extraction, { recursive: true, mode: 0o700 });
    await runFile('/usr/bin/ditto', ['-x', '-k', file, extraction]);
    const bundle = path.join(extraction, 'Lithium.app');
    await validateBundle(bundle, version, runFile);
    await runFile('/usr/bin/ditto', [bundle, staged]);
    await validateBundle(staged, version, runFile);
    // Deliberately preserve Gatekeeper/quarantine attributes. No security bypass.
    const helper = path.join(workDir, `install-${token}.sh`);
    fs.copyFileSync(path.join(__dirname, 'install-mac.sh'), helper); fs.chmodSync(helper, 0o700);
    return { token, target, staged, previous, helper, version, result: path.join(workDir, `result-${token}`), health: path.join(workDir, `health-${token}`) };
  } catch (error) { disk.rmSync(staged, { recursive: true, force: true }); throw error; }
  finally { disk.rmSync(extraction, { recursive: true, force: true }); }
}
async function startHelper(job, parentPid = process.pid) {
  const log = fs.openSync(`${job.result}.log`, 'a', 0o600);
  let child;
  try { child = spawn('/bin/sh', [job.helper, String(parentPid), job.target, job.staged, job.previous, job.result, job.health, job.token], { detached: true, stdio: ['ignore', log, log] }); }
  finally { fs.closeSync(log); }
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    const result = fs.existsSync(job.result) ? fs.readFileSync(job.result, 'utf8').trim() : '';
    if (result === 'ready') return child;
    if (result.startsWith('failed')) throw new Error(`Could not start update installer (${result}).`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill(); throw new Error('Update installer did not become ready. Lithium was not closed.');
}
module.exports = { installationPath, validateArchiveEntries, validateBundle, prepareMac, startHelper };
