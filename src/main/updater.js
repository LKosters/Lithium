const { ipcMain, shell } = require("electron");
const https = require("https");
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

function registerUpdaterHandlers() {
  ipcMain.handle("updater:check", async () => {
    try {
      const release = await fetchLatestRelease();
      const latestVersion = release.tag_name.replace(/^v/, "");
      const currentVersion = pkg.version;
      const updateAvailable = compareVersions(currentVersion, latestVersion) > 0;

      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseUrl: release.html_url,
        releaseName: release.name || release.tag_name,
        publishedAt: release.published_at,
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("updater:get-version", () => pkg.version);

  ipcMain.on("updater:open-release", (_e, url) => {
    shell.openExternal(url);
  });
}

module.exports = { registerUpdaterHandlers };
