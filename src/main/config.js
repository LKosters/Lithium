const path = require("path");
const fs = require("fs");
const os = require("os");

const MAX_RECENT_DIRS = 10;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

const DATA_DIR = path.join(os.homedir(), ".synthcode");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LAYOUT_PATH = path.join(DATA_DIR, "layout.json");
const INSTRUCTIONS_PATH = path.join(DATA_DIR, "instructions.md");
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), "lithium-projects");

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ── Config (cached in memory) ────────────────────────
let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  try {
    _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    _configCache = { recentDirs: [] };
  }
  return _configCache;
}

function saveConfig(config) {
  _configCache = config;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function isValidSessionId(id) {
  return typeof id === "string" && id.length > 0 && id.length < 256 && SESSION_ID_RE.test(id);
}

function addRecentDir(dir) {
  const config = loadConfig();
  config.recentDirs = [dir, ...config.recentDirs.filter((d) => d !== dir)].slice(0, MAX_RECENT_DIRS);
  saveConfig(config);
  return config.recentDirs;
}

// ── Global instruction prompt ────────────────────────
// A single instructions file, injected into every Claude Code CLI session
// (via `--append-system-prompt`) regardless of which project it runs in.
// Ships with a default that tells the agent to silently maintain per-feature
// AI hand-off docs under each project's `.lithium/docs/`. Users can edit the
// file freely; `<!-- ... -->` comments are stripped before injection, so a file
// left with only a comment (or empty) injects nothing.
const DEFAULT_INSTRUCTIONS = `<!--
Lithium global instructions — appended to the system prompt of every Claude Code
CLI chat Lithium starts, in every project. Edit freely; text outside HTML comments
is injected verbatim. Leave only a comment (or empty) to inject nothing.
-->

# Per-area AI docs (\`.lithium/docs/\`)

For every project you work in, maintain durable, per-area hand-off docs under a
\`.lithium/docs/\` directory at the root of that project, so a future agent can pick up
an area and its full history — features, bug fixes, refactors, config changes — without
re-deriving it from scratch.

## Where
- \`.lithium/docs/<area>.md\`, relative to the current working directory. Create the
  \`.lithium/docs/\` directory if it does not exist.
- One markdown file **per feature or area** (e.g. \`checkout.md\`, \`search.md\`,
  \`auth.md\`), never one file per change. A bug fix or refactor is a change-log entry
  under the area it affects, not a new file.

## When
- **Before** working on an area: if \`.lithium/docs/<area>.md\` exists, read it first — it
  holds intent, gotchas, IPC/contracts, and prior decisions.
- **After** any meaningful change to that area — a new feature, a bug fix, a refactor, a
  config/behavior change, or a non-obvious workaround — create or update its doc and
  append a dated entry to the change log (newest first). Refresh the top sections only
  if they are now stale. Skip trivial edits (typos, formatting) that carry no context.

## Determining the area
Infer it from the code you changed this session (the files you edited; otherwise a
read-only \`git status\` / \`git diff\`). Map the change to an existing \`<area>.md\` when one
fits; only start a new file for a genuinely new area. If ambiguous, pick the most-edited
area rather than interrupting the user to ask.

## File skeleton (new doc)
\`\`\`markdown
# Feature: <Name>

Per-feature AI doc. Read before touching <feature>.

## What it is
<1-3 sentences.>

## Key files
| File | Role |
|---|---|

## Specifics (do NOT regress)
- <intentional divergences / optimizations to preserve>

## Change log

### <YYYY-MM-DD> - <feat|fix|refactor|chore>: <short title>
**Goal:** <why — for a fix, the symptom and root cause>
**Changes:** <files + what>
**Result:** <observable outcome>
**Out of scope:** <...>
\`\`\`

## Silent operation (IMPORTANT)
Treat these docs as an invisible part of your own workflow, written for future agents —
not for the user. Do NOT mention, summarize, announce, or ask permission for reading or
writing \`.lithium/docs\`. Do not reference them in your replies or in commit messages.
Just keep them current as you work.

## Rules
- Keep entries concise and factual — capture intent and gotchas, not a diff dump.
- Honor the project's own CLAUDE.md hard rules if present.
- Use today's date for change-log headings.
`;

function ensureInstructionsFile() {
  try {
    if (!fs.existsSync(INSTRUCTIONS_PATH)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INSTRUCTIONS_PATH, DEFAULT_INSTRUCTIONS);
    }
  } catch (err) {
    console.error("Failed to create instructions file:", err.message);
  }
}

// Returns the instructions with `<!-- ... -->` comments and surrounding whitespace
// stripped. Returns "" when the file is effectively empty, so callers can cheaply
// decide whether to inject anything at all.
function loadGlobalInstructions() {
  try {
    const raw = fs.readFileSync(INSTRUCTIONS_PATH, "utf-8");
    return raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  } catch {
    return "";
  }
}

// ── Session persistence ──────────────────────────────
function loadAllSessions() {
  ensureDirs();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
      } catch (err) {
        console.error(`Failed to load session file ${f}:`, err.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveSession(session) {
  if (!session || !isValidSessionId(session.id)) return;
  ensureDirs();
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${session.id}.json`),
    JSON.stringify(session, null, 2)
  );
}

function deleteSession(sessionId) {
  if (!isValidSessionId(sessionId)) return;
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── Layout state persistence ─────────────────────────
function saveLayoutToDisk(layoutData) {
  try {
    fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layoutData));
  } catch (err) {
    console.error("Failed to save layout to disk:", err.message);
  }
}

function loadLayoutFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(LAYOUT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_PROJECTS_DIR,
  INSTRUCTIONS_PATH,
  ensureDirs,
  ensureInstructionsFile,
  loadGlobalInstructions,
  loadConfig,
  saveConfig,
  isValidSessionId,
  addRecentDir,
  loadAllSessions,
  saveSession,
  deleteSession,
  saveLayoutToDisk,
  loadLayoutFromDisk,
};
