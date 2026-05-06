// Electron GUI apps don't inherit the user's shell PATH on macOS / Linux when
// launched from Finder / Dock / Launchpad. That's why bundled CLIs like
// `claude` (shebang `#!/usr/bin/env node`) fail at spawn time with:
//   env: node: No such file or directory
//
// This module queries the user's login shell once for its PATH and merges
// sensible fallback locations (Homebrew, /usr/local, npm-global, nvm, Volta,
// fnm, asdf) so child processes can always resolve `node`, `npx`, `claude`.

const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

let fixed = false;

function fallbackDirs() {
  const home = os.homedir();
  const dirs = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".npm-global/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".local/bin"),
    path.join(home, "bin"),
  ];

  // nvm: default-alias version, then anything under versions/node/*/bin
  try {
    const aliasFile = path.join(home, ".nvm/alias/default");
    if (fs.existsSync(aliasFile)) {
      const v = fs.readFileSync(aliasFile, "utf-8").trim();
      const p = path.join(home, ".nvm/versions/node", v.startsWith("v") ? v : `v${v}`, "bin");
      dirs.push(p);
    }
  } catch {}
  try {
    const nvmRoot = path.join(home, ".nvm/versions/node");
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot)) {
        dirs.push(path.join(nvmRoot, v, "bin"));
      }
    }
  } catch {}

  // fnm: one multishell directory per shell, plus installed versions
  try {
    const fnmRoot = path.join(home, ".fnm/node-versions");
    if (fs.existsSync(fnmRoot)) {
      for (const v of fs.readdirSync(fnmRoot)) {
        dirs.push(path.join(fnmRoot, v, "installation/bin"));
      }
    }
  } catch {}

  // asdf shims
  dirs.push(path.join(home, ".asdf/shims"));

  return dirs.filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
}

function queryLoginShellPath() {
  // Only meaningful on macOS / Linux; on Windows PATH already works.
  if (process.platform === "win32") return null;

  const shell = process.env.SHELL || "/bin/bash";
  // -i (interactive) makes zsh/bash source interactive init files (e.g. ~/.zshrc)
  // where users add nvm / fnm / Volta shims. -l (login) sources login files
  // (~/.zprofile, ~/.bash_profile) where Homebrew paths live. Some init scripts
  // print welcome banners, so wrap the value in markers we can parse out.
  const START = "__LITHIUM_PATH_START__";
  const END = "__LITHIUM_PATH_END__";
  try {
    const out = execFileSync(
      shell,
      ["-ilc", `command printf %s "${START}$PATH${END}"`],
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const s = String(out);
    const start = s.indexOf(START);
    const end = s.indexOf(END, start + START.length);
    if (start < 0 || end < 0) return null;
    const p = s.slice(start + START.length, end).trim();
    return p || null;
  } catch {
    return null;
  }
}

function fixPath() {
  if (fixed) return process.env.PATH;
  fixed = true;

  const current = process.env.PATH || "";
  const shellPath = queryLoginShellPath();
  const fallback = fallbackDirs().join(path.delimiter);

  const parts = [shellPath, current, fallback]
    .filter(Boolean)
    .join(path.delimiter)
    .split(path.delimiter);

  const seen = new Set();
  const merged = [];
  for (const part of parts) {
    if (!part) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    merged.push(part);
  }

  process.env.PATH = merged.join(path.delimiter);
  return process.env.PATH;
}

module.exports = { fixPath };
