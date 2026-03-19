const { ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { addRecentDir } = require("./config");

ipcMain.handle("project:create", async (_e, { framework, name, projectsDir }) => {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { ok: false, error: "Invalid project name. Use only letters, numbers, dashes and underscores." };
  }
  const targetDir = path.join(projectsDir, name);
  if (fs.existsSync(targetDir)) {
    return { ok: false, error: `Directory "${name}" already exists in projects folder.` };
  }

  let cmd, args;
  if (framework === "nextjs") {
    cmd = "npx";
    args = ["create-next-app@latest", name, "--yes"];
  } else {
    return { ok: false, error: `Unknown framework: ${framework}` };
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: projectsDir,
      shell: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(targetDir)) {
        addRecentDir(targetDir);
        resolve({ ok: true, dir: targetDir });
      } else {
        const meaningful = stderr
          .split("\n")
          .filter((l) => !/^npm warn\b/i.test(l.trim()))
          .join("\n")
          .trim();
        resolve({ ok: false, error: meaningful || `Process exited with code ${code}` });
      }
    });
  });
});
