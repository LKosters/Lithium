const { ipcMain } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

const GIT_TIMEOUT_MS = 5000;

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

// Factory for simple git commands that return success/failure
function registerGitCommand(channel, argsBuilder) {
  ipcMain.handle(channel, async (_e, params) => {
    const res = await runGit(argsBuilder(params), params.cwd);
    return res !== null;
  });
}

registerGitCommand("git:stage-all", () => ["add", "-A"]);
registerGitCommand("git:stage-file", ({ file }) => ["add", "--", file]);
registerGitCommand("git:unstage-file", ({ file }) => ["reset", "HEAD", "--", file]);
registerGitCommand("git:commit", ({ message }) => ["commit", "-m", message]);
registerGitCommand("git:push", () => ["push"]);

ipcMain.handle("git:status", async (_e, { cwd }) => {
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch) return null;

  const statusRaw = await runGit(["status", "--porcelain"], cwd);
  const staged = [];
  const changes = [];

  if (statusRaw) {
    for (const line of statusRaw.split("\n")) {
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      const file = line.substring(3);

      if (x !== " " && x !== "?") {
        staged.push({ file, status: x });
      }
      if (y !== " " || x === "?") {
        changes.push({ file, status: x === "?" ? "?" : y });
      }
    }
  }

  const logRaw = await runGit(
    ["log", "--oneline", "--format=%h||%s||%cr||%an", "-10"],
    cwd
  );
  const log = logRaw
    ? logRaw.split("\n").filter(Boolean).map((l) => {
        const [hash, msg, time, author] = l.split("||");
        return { hash, msg, time, author };
      })
    : [];

  const topLevel = await runGit(["rev-parse", "--show-toplevel"], cwd);
  const repoName = topLevel ? path.basename(topLevel) : null;
  const remoteUrl = await runGit(["remote", "get-url", "origin"], cwd);

  return { branch, staged, changes, log, repoName, remoteUrl };
});

ipcMain.handle("git:branches", async (_e, { cwd }) => {
  const raw = await runGit(["branch", "-a", "--format=%(refname:short)||%(HEAD)"], cwd);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((l) => {
    const [name, head] = l.split("||");
    return { name: name.trim(), current: head.trim() === "*" };
  });
});

ipcMain.handle("git:checkout", async (_e, { cwd, branch }) => {
  const res = await runGit(["checkout", branch], cwd);
  return res !== null;
});

ipcMain.handle("git:create-branch", async (_e, { cwd, branch }) => {
  const res = await runGit(["checkout", "-b", branch], cwd);
  return res !== null;
});
