#!/usr/bin/env node
// Standalone MCP server for browser control — spawned by codex-acp as stdio child process.
// Zero npm dependencies. Communicates with Electron main process via TCP bridge.

const net = require("net");
const readline = require("readline");

const BRIDGE_PORT = parseInt(process.env.BROWSER_BRIDGE_PORT, 10);
if (!BRIDGE_PORT) {
  process.stderr.write("[browser-mcp] BROWSER_BRIDGE_PORT not set\n");
  process.exit(1);
}

// ── TCP connection to Electron bridge ────────────────────
let bridge = null;
let bridgeBuffer = "";
let bridgePending = new Map(); // id -> { resolve, reject }
let bridgeNextId = 1;

function connectBridge() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: BRIDGE_PORT }, () => {
      bridge = sock;
      resolve();
    });
    sock.on("error", (err) => {
      bridge = null;
      reject(err);
    });
    sock.on("close", () => {
      bridge = null;
    });
    sock.on("data", (data) => {
      bridgeBuffer += data.toString();
      const lines = bridgeBuffer.split("\n");
      bridgeBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const pending = bridgePending.get(msg.id);
          if (pending) {
            bridgePending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error));
            else pending.resolve(msg.result);
          }
        } catch {}
      }
    });
  });
}

function callBridge(tool, args) {
  return new Promise((resolve, reject) => {
    if (!bridge || bridge.destroyed) {
      return reject(new Error("Bridge not connected"));
    }
    const id = bridgeNextId++;
    bridgePending.set(id, { resolve, reject });
    bridge.write(JSON.stringify({ id, tool, args }) + "\n");

    setTimeout(() => {
      if (bridgePending.has(id)) {
        bridgePending.delete(id);
        reject(new Error("Bridge request timed out"));
      }
    }, 30000);
  });
}

// ── MCP tools definition ─────────────────────────────────
const TOOLS = [
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page in the browser panel. Returns a base64-encoded PNG image.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_navigate",
    description: "Navigate the browser panel to a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "browser_get_url",
    description: "Get the current URL of the browser panel.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_get_text",
    description: "Get the visible text content of the current page in the browser panel.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_execute_js",
    description: "Execute JavaScript code in the browser panel page context and return the result.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "JavaScript code to execute" } },
      required: ["code"],
    },
  },
  {
    name: "browser_click",
    description: "Click at specific coordinates in the browser panel page.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "browser_is_open",
    description: "Check if the browser panel is currently open and visible.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ── MCP JSON-RPC handler ─────────────────────────────────
function sendResponse(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id, code, message) {
  const msg = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "browser-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // No response needed for notifications
    return;
  }

  if (method === "tools/list") {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      // Ensure bridge is connected
      if (!bridge || bridge.destroyed) {
        await connectBridge();
      }

      const result = await callBridge(toolName, toolArgs);

      // If the result contains a base64 image, return it as an image content part
      if (result && result._type === "image") {
        sendResponse(id, {
          content: [{ type: "image", data: result.data, mimeType: result.mimeType || "image/png" }],
        });
      } else {
        const text = typeof result === "string" ? result : JSON.stringify(result);
        sendResponse(id, { content: [{ type: "text", text }] });
      }
    } catch (err) {
      sendResponse(id, {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      });
    }
    return;
  }

  // Unknown method
  if (id != null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Stdin reading (line-delimited JSON-RPC) ──────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleRequest(msg).catch((err) => {
      process.stderr.write(`[browser-mcp] Error handling ${msg.method}: ${err.message}\n`);
      if (msg.id != null) {
        sendError(msg.id, -32603, err.message);
      }
    });
  } catch {
    process.stderr.write(`[browser-mcp] Invalid JSON: ${trimmed.slice(0, 100)}\n`);
  }
});

rl.on("close", () => {
  if (bridge) bridge.destroy();
  process.exit(0);
});

// Connect to bridge eagerly
connectBridge().catch((err) => {
  process.stderr.write(`[browser-mcp] Initial bridge connection failed (will retry on demand): ${err.message}\n`);
});
