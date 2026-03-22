// TCP bridge — runs in Electron main process.
// Receives tool requests from browser-mcp-server via TCP,
// forwards them to the renderer via IPC, and returns results.

const net = require("net");
const { ipcMain, BrowserWindow } = require("electron");

let server = null;
let bridgePort = null;
let pendingRequests = new Map(); // requestId -> { socket, id }

function startBrowserBridge() {
  return new Promise((resolve, reject) => {
    server = net.createServer((socket) => {
      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleBridgeRequest(socket, msg);
          } catch (err) {
            console.error("[browser-bridge] Invalid JSON from MCP server:", err.message);
          }
        }
      });

      socket.on("error", (err) => {
        console.error("[browser-bridge] Socket error:", err.message);
      });

      socket.on("close", () => {
        // Clean up any pending requests for this socket
        for (const [reqId, entry] of pendingRequests) {
          if (entry.socket === socket) {
            pendingRequests.delete(reqId);
          }
        }
      });
    });

    server.on("error", (err) => {
      console.error("[browser-bridge] Server error:", err.message);
      reject(err);
    });

    // Listen on port 0 for OS-assigned random port
    server.listen(0, "127.0.0.1", () => {
      bridgePort = server.address().port;
      console.log(`[browser-bridge] Listening on port ${bridgePort}`);
      resolve(bridgePort);
    });
  });
}

function handleBridgeRequest(socket, msg) {
  const { id, tool, args } = msg;
  const requestId = `bridge-${id}-${Date.now()}`;

  // Store pending request so we can route the response back
  pendingRequests.set(requestId, { socket, id });

  // Forward to renderer via IPC
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    sendBridgeResponse(socket, id, null, "No application window available");
    pendingRequests.delete(requestId);
    return;
  }

  win.webContents.send("browser-tool:exec", { requestId, tool, args });

  // Timeout after 30s
  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.delete(requestId);
      sendBridgeResponse(socket, id, null, "Request timed out");
    }
  }, 30000);
}

function sendBridgeResponse(socket, id, result, error) {
  if (socket.destroyed) return;
  try {
    const msg = error ? { id, error } : { id, result };
    socket.write(JSON.stringify(msg) + "\n");
  } catch (err) {
    console.error("[browser-bridge] Write error:", err.message);
  }
}

// Handle responses from renderer
function registerBridgeIPC() {
  ipcMain.on("browser-tool:result", (_e, { requestId, result, error }) => {
    const entry = pendingRequests.get(requestId);
    if (!entry) return;
    pendingRequests.delete(requestId);
    sendBridgeResponse(entry.socket, entry.id, result, error);
  });
}

function stopBrowserBridge() {
  if (server) {
    server.close();
    server = null;
    bridgePort = null;
    pendingRequests.clear();
    console.log("[browser-bridge] Stopped");
  }
}

function getBridgePort() {
  return bridgePort;
}

module.exports = { startBrowserBridge, stopBrowserBridge, getBridgePort, registerBridgeIPC };
