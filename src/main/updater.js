const { ipcMain, shell, app } = require("electron");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const pkg = require("../../package.json");

const REPO_OWNER = "lkosters";
const REPO_NAME = "lithium";

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      headers: { "User-Agent": "Lithium-Updater" },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`GitHub API returned ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

function compareVersions(current, latest) {
  const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (lv > cv) return 1;
    if (lv < cv) return -1;
  }
  return 0;
}

function getPlatformAssetPattern() {
  switch (process.platform) {
    case "darwin": return /\.dmg$/i;
    case "win32": return /\.exe$/i;
    case "linux": return /\.AppImage$/i;
    default: return null;
  }
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      const proto = url.startsWith("https") ? https : require("http");
      proto.get(url, { headers: { "User-Agent": "Lithium-Updater" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers["content-length"], 10) || 0;
        let downloadedBytes = 0;
        const file = fs.createWriteStream(destPath);

        res.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) {
            onProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        });

        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(destPath)));
        file.on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on("error", reject);
    };
    follow(url);
  });
}

function installUpdate(filePath) {
  switch (process.platform) {
    case "darwin":
      // Mount DMG and open it so the user can drag to Applications
      exec(`open "${filePath}"`, () => {
        setTimeout(() => app.quit(), 1000);
      });
      break;
    case "win32":
      // Run the NSIS installer
      exec(`start "" "${filePath}"`, () => {
        setTimeout(() => app.quit(), 1000);
      });
      break;
    case "linux":
      // Make AppImage executable and launch it
      fs.chmodSync(filePath, 0o755);
      exec(`"${filePath}" &`, () => {
        setTimeout(() => app.quit(), 1000);
      });
      break;
  }
}

function registerUpdaterHandlers() {
  ipcMain.handle("updater:check", async () => {
    try {
      const release = await fetchLatestRelease();
      const latestVersion = release.tag_name.replace(/^v/, "");
      const currentVersion = pkg.version;
      const updateAvailable = compareVersions(currentVersion, latestVersion) > 0;

      // Find the correct asset for this platform
      const pattern = getPlatformAssetPattern();
      const asset = pattern
        ? (release.assets || []).find((a) => pattern.test(a.name))
        : null;

      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseUrl: release.html_url,
        downloadUrl: asset ? asset.browser_download_url : null,
        assetName: asset ? asset.name : null,
        assetSize: asset ? asset.size : 0,
        releaseName: release.name || release.tag_name,
        publishedAt: release.published_at,
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("updater:download-and-install", async (event, { downloadUrl, assetName }) => {
    try {
      const tmpDir = app.getPath("temp");
      const destPath = path.join(tmpDir, assetName);

      // Download with progress
      await downloadFile(downloadUrl, destPath, (percent) => {
        event.sender.send("updater:download-progress", percent);
      });

      // Install
      installUpdate(destPath);
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("updater:get-version", () => pkg.version);

  // Keep legacy handler for fallback
  ipcMain.on("updater:open-release", (_e, url) => {
    shell.openExternal(url);
  });
}

module.exports = { registerUpdaterHandlers };
