// Claude Agent SDK provider
// Uses @anthropic-ai/claude-code or direct Anthropic API

let Anthropic = null;
try { Anthropic = require("@anthropic-ai/sdk"); } catch {}

class ClaudeAgentProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = "claude";
    this.label = "Claude";
    this.client = null;
    this.abortControllers = new Map();
  }

  isAvailable() {
    return !!(this.apiKey && Anthropic);
  }

  init() {
    if (!Anthropic) throw new Error("@anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk");
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    if (!this.client) this.init();

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    const systemPrompt = opts.systemPrompt || "You are a helpful coding assistant. You help users write, debug, and understand code. Format your responses using markdown.";

    try {
      const apiMessages = messages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }));

      const stream = this.client.messages.stream({
        model: opts.model || "claude-sonnet-4-20250514",
        max_tokens: opts.maxTokens || 8192,
        system: systemPrompt,
        messages: apiMessages,
      });

      let fullText = "";

      stream.on("text", (text) => {
        if (controller.signal.aborted) return;
        fullText += text;
        onChunk({ type: "text_delta", text });
      });

      await stream.finalMessage();

      this.abortControllers.delete(sessionId);
      return { content: fullText, role: "assistant" };
    } catch (err) {
      this.abortControllers.delete(sessionId);
      if (err.name === "AbortError" || controller.signal.aborted) {
        return { content: "", role: "assistant", aborted: true };
      }
      throw err;
    }
  }

  abort(sessionId) {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }
}

module.exports = { ClaudeAgentProvider };
