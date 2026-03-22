// Base ACP provider — handles session management, streaming, and context rotation
// for any ACP-compatible agent. Subclass or instantiate with a server manager.

const CONTEXT_THRESHOLD = 0.80;

class BaseACPProvider {
  constructor({ name, label, server }) {
    this.name = name;
    this.label = label;
    this.server = server;

    this._sessions = new Map();     // chatSessionId -> acpSessionId
    this._sessionCwds = new Map();  // chatSessionId -> cwd used
    this._sessionUsage = new Map(); // chatSessionId -> { used, size }
    this._activeCallbacks = new Map();
    this._resolvers = new Map();

    server.setUpdateCallback((acpSessionId, update) => {
      for (const [chatSid, acpSid] of this._sessions) {
        if (acpSid === acpSessionId) {
          this._handleUpdate(chatSid, update);
          break;
        }
      }
    });
  }

  isAvailable() {
    return this.server.isRunning();
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
      this._sessionUsage.set(sessionId, { used: update.used || 0, size: update.size || 0 });
      cb({ type: "usage", used: update.used || 0, size: update.size || 0 });
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
    const usage = this._sessionUsage.get(sessionId);
    if (!usage || !usage.size) return false;
    return (usage.used / usage.size) >= CONTEXT_THRESHOLD;
  }

  async _summarizeAndRotate(sessionId, messages, opts, onChunk) {
    console.log(`[${this.name}] Context at threshold — summarizing and rotating session`);

    const acpSessionId = this._sessions.get(sessionId);
    const summaryHolder = { fullText: "" };
    this._activeCallbacks.set(sessionId, () => {});
    this._resolvers.set(sessionId, summaryHolder);

    try {
      await this.server.sendPrompt(acpSessionId,
        "Summarize our entire conversation so far in a concise but detailed way. " +
        "Include: what the user asked for, key decisions made, what files were changed, " +
        "current state of the project, and any unfinished work. " +
        "This summary will be used to continue the conversation in a fresh context window."
      );
    } catch (err) {
      console.error(`[${this.name}] Summary request failed:`, err.message);
      return false;
    }

    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);

    const summary = summaryHolder.fullText;
    if (!summary) {
      console.warn(`[${this.name}] Empty summary, skipping rotation`);
      return false;
    }

    const cwd = opts.cwd || undefined;
    const newAcpSid = await this.server.createSession(cwd);
    this._sessions.set(sessionId, newAcpSid);
    this._sessionUsage.delete(sessionId);

    const primeHolder = { fullText: "" };
    this._activeCallbacks.set(sessionId, () => {});
    this._resolvers.set(sessionId, primeHolder);

    try {
      await this.server.sendPrompt(newAcpSid,
        "Here is a summary of our previous conversation that ran out of context space. " +
        "Continue from where we left off. Do not repeat the summary back to me.\n\n" +
        "--- CONVERSATION SUMMARY ---\n" + summary + "\n--- END SUMMARY ---"
      );
    } catch (err) {
      console.error(`[${this.name}] Prime failed:`, err.message);
    }

    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);

    if (onChunk) {
      onChunk({ type: "text_delta", text: "\n\n---\n*Context was getting full — conversation was summarized and continued in a fresh session.*\n---\n\n" });
    }

    console.log(`[${this.name}] Session rotated successfully`);
    return true;
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    const requestedCwd = opts.cwd || null;

    // Ensure server is running in the correct project directory
    if (requestedCwd) {
      await this.server.ensureCwd(requestedCwd);
    }

    if (!this.server.isRunning()) {
      throw new Error(`${this.label} is not running. Start it in Settings > Agents.`);
    }

    // Create session if needed, or if cwd changed
    const existingCwd = this._sessionCwds.get(sessionId) || null;
    if (!this._sessions.has(sessionId) || (requestedCwd && requestedCwd !== existingCwd)) {
      if (this._sessions.has(sessionId)) {
        console.log(`[${this.name}] Project directory changed from`, existingCwd, "to", requestedCwd, "— creating new session");
      }
      const acpSid = await this.server.createSession(requestedCwd);
      this._sessions.set(sessionId, acpSid);
      this._sessionCwds.set(sessionId, requestedCwd);
    }

    // Summarize if context is getting full
    if (this._needsSummarization(sessionId)) {
      await this._summarizeAndRotate(sessionId, messages, opts, onChunk);
    }

    const acpSessionId = this._sessions.get(sessionId);
    const lastMessage = messages[messages.length - 1];
    const text = lastMessage?.content || "";
    const images = lastMessage?.images || [];

    // Build prompt parts
    const promptParts = [];
    if (text) promptParts.push({ type: "text", text });
    for (const img of images) {
      const base64 = img.dataUrl.replace(/^data:[^;]+;base64,/, "");
      promptParts.push({ type: "image", image: base64, mimeType: img.mimeType });
    }
    if (promptParts.length === 0) promptParts.push({ type: "text", text: "" });

    this._activeCallbacks.set(sessionId, onChunk);
    const fullTextHolder = { fullText: "" };
    this._resolvers.set(sessionId, fullTextHolder);

    try {
      await this.server.sendPrompt(acpSessionId, promptParts);
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
    this._sessions.delete(sessionId);
    this._sessionCwds.delete(sessionId);
    this._sessionUsage.delete(sessionId);
    this._activeCallbacks.delete(sessionId);
    this._resolvers.delete(sessionId);
  }
}

module.exports = { BaseACPProvider };
