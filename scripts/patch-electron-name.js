/**
 * Patches the Electron.app Info.plist so macOS shows "Lithium"
 * in the menu bar during development (npm start).
 *
 * Searches local node_modules first, then the npx cache.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "Lithium";
const PLIST_SUFFIX = path.join("electron", "dist", "Electron.app", "Contents", "Info.plist");

function findPlist() {
  // 1. Local node_modules
  const local = path.join(__dirname, "..", "node_modules", PLIST_SUFFIX);
  if (fs.existsSync(local)) return local;

  // 2. npx cache (~/.npm/_npx/*/node_modules/electron/dist/...)
  const npxDir = path.join(os.homedir(), ".npm", "_npx");
  if (fs.existsSync(npxDir)) {
    for (const entry of fs.readdirSync(npxDir)) {
      const candidate = path.join(npxDir, entry, "node_modules", PLIST_SUFFIX);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

const plistPath = findPlist();
if (!plistPath) {
  // Not on macOS or Electron not installed yet — skip silently
  process.exit(0);
}

let plist = fs.readFileSync(plistPath, "utf-8");

// Replace CFBundleDisplayName
plist = plist.replace(
  /(<key>CFBundleDisplayName<\/key>\s*<string>)([^<]*?)(<\/string>)/,
  `$1${APP_NAME}$3`
);

// Replace CFBundleName
plist = plist.replace(
  /(<key>CFBundleName<\/key>\s*<string>)([^<]*?)(<\/string>)/,
  `$1${APP_NAME}$3`
);

fs.writeFileSync(plistPath, plist);
console.log(`Patched ${plistPath} → "${APP_NAME}"`);
