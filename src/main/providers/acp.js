// ACP provider — communicates with codex-acp over stdio JSON-RPC
const {
  isACPServerRunning,
  ensureACPServerCwd,
  createSession,
  sendPrompt,
  setUpdateCallback,
} = require("../acp-server");

// Map chat sessionIds to ACP sessionIds
const acpSessions = new Map();
// Track which cwd was used to create each ACP session
const sessionCwds = new Map();

// Track context usage per chat session
const sessionUsage = new Map(); // sessionId -> { used, size }

const CONTEXT_THRESHOLD = 0.80; // 80% — trigger summarization

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
      sessionUsage.set(sessionId, { used: update.used || 0, size: update.size || 0 });
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

  _needsSummarization(sessionId) {
    const usage = sessionUsage.get(sessionId);
    if (!usage || !usage.size) return false;
    return (usage.used / usage.size) >= CONTEXT_THRESHOLD;
  }

  async _summarizeAndRotate(sessionId, messages, opts, onChunk) {
    console.log("[acp] Context at threshold — summarizing and rotating session");

    const acpSessionId = acpSessions.get(sessionId);

    // Ask the current session for a summary
    // Use a no-op callback; the resolver in _handleUpdate accumulates fullText
    const summaryHolder = { fullText: "" };
    this._activeCallbacks.set(sessionId, () => {});
    this._resolvers.set(sessionId, summaryHolder);

    try {
      await sendPrompt(acpSessionId,
        "Summarize our entire conversation so far in a concise but detailed way. " +
        "Include: what the user asked for, key decisions made, what files were changed, " +
        "current state of the project, and any unfinished work. " +
        "This summary will be used to continue the conversation in a fresh context window."
      );
    } catch (err) {
      console.error("[acp] Summary request failed:", err.message);
      // Continue without rotation
      return false;
    }

    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);

    const summary = summaryHolder.fullText;
    if (!summary) {
      console.warn("[acp] Empty summary, skipping rotation");
      return false;
    }

    // Create a new ACP session
    const cwd = opts.cwd || undefined;
    const newAcpSid = await createSession(cwd);
    acpSessions.set(sessionId, newAcpSid);
    sessionUsage.delete(sessionId);

    // Prime the new session with the summary
    const primeHolder = { fullText: "" };
    this._activeCallbacks.set(sessionId, () => {}); // swallow prime response
    this._resolvers.set(sessionId, primeHolder);

    try {
      await sendPrompt(newAcpSid,
        "Here is a summary of our previous conversation that ran out of context space. " +
        "Continue from where we left off. Do not repeat the summary back to me.\n\n" +
        "--- CONVERSATION SUMMARY ---\n" + summary + "\n--- END SUMMARY ---"
      );
    } catch (err) {
      console.error("[acp] Prime failed:", err.message);
    }

    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);

    // Notify the user
    if (onChunk) {
      onChunk({ type: "text_delta", text: "\n\n---\n*Context was getting full — conversation was summarized and continued in a fresh session.*\n---\n\n" });
    }

    console.log("[acp] Session rotated successfully");
    return true;
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    const requestedCwd = opts.cwd || null;

    // Ensure the ACP server process is running in the correct project directory
    if (requestedCwd) {
      await ensureACPServerCwd(requestedCwd);
    }

    if (!isACPServerRunning()) {
      throw new Error("codex-acp is not running. Start it in Settings > Agents.");
    }

    // Create an ACP session if we don't have one, or if the cwd changed
    const existingCwd = sessionCwds.get(sessionId) || null;
    if (!acpSessions.has(sessionId) || (requestedCwd && requestedCwd !== existingCwd)) {
      if (acpSessions.has(sessionId)) {
        console.log("[acp] Project directory changed from", existingCwd, "to", requestedCwd, "— creating new ACP session");
      }
      const acpSid = await createSession(requestedCwd);
      acpSessions.set(sessionId, acpSid);
      sessionCwds.set(sessionId, requestedCwd);
    }

    // Check if we need to summarize before sending
    if (this._needsSummarization(sessionId)) {
      await this._summarizeAndRotate(sessionId, messages, opts, onChunk);
    }

    const acpSessionId = acpSessions.get(sessionId);
    const lastMessage = messages[messages.length - 1];
    const text = lastMessage?.content || "";
    const images = lastMessage?.images || [];

    // Build prompt parts: text + images
    const promptParts = [];
    if (text) promptParts.push({ type: "text", text });
    for (const img of images) {
      // Extract base64 data from data URL
      const base64 = img.dataUrl.replace(/^data:[^;]+;base64,/, "");
      promptParts.push({ type: "image", data: base64, mimeType: img.mimeType });
    }
    if (promptParts.length === 0) promptParts.push({ type: "text", text: "" });

    // Set up streaming callback
    this._activeCallbacks.set(sessionId, onChunk);

    const fullTextHolder = { fullText: "" };
    this._resolvers.set(sessionId, fullTextHolder);

    try {
      // sendPrompt resolves when the agent's turn is complete
      await sendPrompt(acpSessionId, promptParts);

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
    sessionCwds.delete(sessionId);
    sessionUsage.delete(sessionId);
    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);
  }
}

module.exports = { ACPProvider };
