// Cursor ACP provider — communicates with cursor-agent acp over stdio JSON-RPC
const {
  isCursorACPRunning,
  ensureCursorACPServerCwd,
  createCursorSession,
  sendCursorPrompt,
  setCursorUpdateCallback,
} = require("../cursor-acp-server");

const cursorSessions = new Map();
const sessionCwds = new Map();
const sessionUsage = new Map();

const CONTEXT_THRESHOLD = 0.80;

class CursorACPProvider {
  constructor() {
    this.name = "cursor-acp";
    this.label = "Cursor";
    this.abortControllers = new Map();
    this._activeCallbacks = new Map();
    this._resolvers = new Map();

    setCursorUpdateCallback((acpSessionId, update) => {
      for (const [chatSid, acpSid] of cursorSessions) {
        if (acpSid === acpSessionId) {
          this._handleUpdate(chatSid, update);
          break;
        }
      }
    });
  }

  isAvailable() {
    return isCursorACPRunning();
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
    console.log("[cursor-acp] Context at threshold — summarizing and rotating session");

    const acpSessionId = cursorSessions.get(sessionId);
    const summaryHolder = { fullText: "" };
    this._activeCallbacks.set(sessionId, () => {});
    this._resolvers.set(sessionId, summaryHolder);

    try {
      await sendCursorPrompt(acpSessionId,
        "Summarize our entire conversation so far in a concise but detailed way. " +
        "Include: what the user asked for, key decisions made, what files were changed, " +
        "current state of the project, and any unfinished work. " +
        "This summary will be used to continue the conversation in a fresh context window."
      );
    } catch (err) {
      console.error("[cursor-acp] Summary request failed:", err.message);
      return false;
    }

    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);

    const summary = summaryHolder.fullText;
    if (!summary) {
      console.warn("[cursor-acp] Empty summary, skipping rotation");
      return false;
    }

    const cwd = opts.cwd || undefined;
    const newAcpSid = await createCursorSession(cwd);
    cursorSessions.set(sessionId, newAcpSid);
    sessionUsage.delete(sessionId);

    const primeHolder = { fullText: "" };
    this._activeCallbacks.set(sessionId, () => {});
    this._resolvers.set(sessionId, primeHolder);

    try {
      await sendCursorPrompt(newAcpSid,
        "Here is a summary of our previous conversation that ran out of context space. " +
        "Continue from where we left off. Do not repeat the summary back to me.\n\n" +
        "--- CONVERSATION SUMMARY ---\n" + summary + "\n--- END SUMMARY ---"
      );
    } catch (err) {
      console.error("[cursor-acp] Prime failed:", err.message);
    }

    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);

    if (onChunk) {
      onChunk({ type: "text_delta", text: "\n\n---\n*Context was getting full — conversation was summarized and continued in a fresh session.*\n---\n\n" });
    }

    console.log("[cursor-acp] Session rotated successfully");
    return true;
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    const requestedCwd = opts.cwd || null;

    // Ensure the Cursor ACP server process is running in the correct project directory
    if (requestedCwd) {
      await ensureCursorACPServerCwd(requestedCwd);
    }

    if (!isCursorACPRunning()) {
      throw new Error("Cursor ACP is not running. Start it in Settings > Agents.");
    }

    // Create session if we don't have one, or if the cwd changed
    const existingCwd = sessionCwds.get(sessionId) || null;
    if (!cursorSessions.has(sessionId) || (requestedCwd && requestedCwd !== existingCwd)) {
      if (cursorSessions.has(sessionId)) {
        console.log("[cursor-acp] Project directory changed from", existingCwd, "to", requestedCwd, "— creating new session");
      }
      const acpSid = await createCursorSession(requestedCwd);
      cursorSessions.set(sessionId, acpSid);
      sessionCwds.set(sessionId, requestedCwd);
    }

    if (this._needsSummarization(sessionId)) {
      await this._summarizeAndRotate(sessionId, messages, opts, onChunk);
    }

    const acpSessionId = cursorSessions.get(sessionId);
    const lastMessage = messages[messages.length - 1];
    const text = lastMessage?.content || "";
    const images = lastMessage?.images || [];

    const promptParts = [];
    if (text) promptParts.push({ type: "text", text });
    for (const img of images) {
      const base64 = img.dataUrl.replace(/^data:[^;]+;base64,/, "");
      promptParts.push({ type: "image", data: base64, mimeType: img.mimeType });
    }
    if (promptParts.length === 0) promptParts.push({ type: "text", text: "" });

    this._activeCallbacks.set(sessionId, onChunk);

    const fullTextHolder = { fullText: "" };
    this._resolvers.set(sessionId, fullTextHolder);

    try {
      await sendCursorPrompt(acpSessionId, promptParts);

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
    cursorSessions.delete(sessionId);
    sessionCwds.delete(sessionId);
    sessionUsage.delete(sessionId);
    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);
  }
}

module.exports = { CursorACPProvider };
