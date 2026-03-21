// ACP provider — communicates with codex-acp over stdio JSON-RPC
const {
  isACPServerRunning,
  createSession,
  sendPrompt,
  setUpdateCallback,
} = require("../acp-server");

// Map chat sessionIds to ACP sessionIds
const acpSessions = new Map();

class ACPProvider {
  constructor() {
    this.name = "acp";
    this.label = "Codex";
    this.abortControllers = new Map();
    this._activeCallbacks = new Map(); // sessionId -> onChunk
    this._resolvers = new Map(); // sessionId -> { resolve, fullText }

    // Listen for session/update notifications
    setUpdateCallback((acpSessionId, update) => {
      // Find which chat session this belongs to
      for (const [chatSid, acpSid] of acpSessions) {
        if (acpSid === acpSessionId) {
          this._handleUpdate(chatSid, update);
          break;
        }
      }
    });
  }

  isAvailable() {
    return isACPServerRunning();
  }

  _handleUpdate(sessionId, update) {
    const cb = this._activeCallbacks.get(sessionId);
    if (!cb) return;

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.text || "";
      if (text) {
        cb({ type: "text_delta", text });
        const resolver = this._resolvers.get(sessionId);
        if (resolver) resolver.fullText += text;
      }
    } else if (update.sessionUpdate === "usage_update") {
      cb({
        type: "usage",
        used: update.used || 0,
        size: update.size || 0,
      });
    } else if (update.sessionUpdate === "tool_call") {
      cb({
        type: "tool_call",
        title: update.title || "Running tool...",
        status: update.status || "pending",
        kind: update.kind || "",
        toolCallId: update.toolCallId || "",
      });
    }
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    if (!isACPServerRunning()) {
      throw new Error("codex-acp is not running. Start it in Settings > Agents.");
    }

    // Create an ACP session if we don't have one
    if (!acpSessions.has(sessionId)) {
      const acpSid = await createSession(opts.cwd);
      acpSessions.set(sessionId, acpSid);
    }

    const acpSessionId = acpSessions.get(sessionId);
    const lastMessage = messages[messages.length - 1];
    const text = lastMessage?.content || "";

    // Set up streaming callback
    this._activeCallbacks.set(sessionId, onChunk);

    const fullTextHolder = { fullText: "" };
    this._resolvers.set(sessionId, fullTextHolder);

    try {
      // sendPrompt resolves when the agent's turn is complete
      await sendPrompt(acpSessionId, text);

      this._activeCallbacks.delete(sessionId);
      this._resolvers.delete(sessionId);

      return { content: fullTextHolder.fullText, role: "assistant" };
    } catch (err) {
      this._activeCallbacks.delete(sessionId);
      this._resolvers.delete(sessionId);
      throw err;
    }
  }

  abort(sessionId) {
    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);
  }

  clearSession(sessionId) {
    acpSessions.delete(sessionId);
    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);
  }
}

module.exports = { ACPProvider };
