// OpenAI / ChatGPT Codex provider

const https = require("https");

class OpenAICodexProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = "codex";
    this.label = "ChatGPT Codex";
    this.abortControllers = new Map();
  }

  isAvailable() {
    return !!this.apiKey;
  }

  init() {
    if (!this.apiKey) throw new Error("OpenAI API key not configured");
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    this.init();

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    const systemPrompt = opts.systemPrompt || "You are a helpful coding assistant. You help users write, debug, and understand code. Format your responses using markdown.";

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
    ];

    const body = JSON.stringify({
      model: opts.model || "gpt-4o",
      messages: apiMessages,
      max_tokens: opts.maxTokens || 8192,
      stream: true,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: opts.baseUrl ? new URL(opts.baseUrl).hostname : "api.openai.com",
          port: 443,
          path: opts.baseUrl ? new URL(opts.baseUrl).pathname + "/chat/completions" : "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
        (res) => {
          let fullText = "";
          let buffer = "";

          res.on("data", (chunk) => {
            if (controller.signal.aborted) return;

            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;
              const data = trimmed.slice(6);
              if (data === "[DONE]") continue;

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  onChunk({ type: "text_delta", text: delta });
                }
              } catch {}
            }
          });

          res.on("end", () => {
            this.abortControllers.delete(sessionId);
            resolve({ content: fullText, role: "assistant" });
          });

          res.on("error", (err) => {
            this.abortControllers.delete(sessionId);
            reject(err);
          });
        }
      );

      controller.signal.addEventListener("abort", () => {
        req.destroy();
        this.abortControllers.delete(sessionId);
        resolve({ content: "", role: "assistant", aborted: true });
      });

      req.on("error", (err) => {
        this.abortControllers.delete(sessionId);
        if (controller.signal.aborted) {
          resolve({ content: "", role: "assistant", aborted: true });
        } else {
          reject(err);
        }
      });

      req.write(body);
      req.end();
    });
  }

  abort(sessionId) {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }
}

module.exports = { OpenAICodexProvider };
