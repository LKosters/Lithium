// ACP (Agent Communication Protocol) provider
// Connects to any ACP-compatible agent server

const https = require("https");
const http = require("http");

class ACPProvider {
  constructor(config) {
    this.endpoint = config?.endpoint || "http://localhost:3001";
    this.apiKey = config?.apiKey || null;
    this.name = "acp";
    this.label = "ACP Agent";
    this.abortControllers = new Map();
  }

  isAvailable() {
    return !!this.endpoint;
  }

  init() {
    if (!this.endpoint) throw new Error("ACP endpoint not configured");
  }

  async sendMessage(sessionId, messages, opts, onChunk) {
    this.init();

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    const url = new URL(this.endpoint);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/chat",
      id: sessionId,
      params: {
        messages: messages.map(m => ({
          role: m.role,
          content: { type: "text", text: m.content },
        })),
        sessionId,
        stream: true,
        ...(opts.model ? { model: opts.model } : {}),
      },
    });

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname === "/" ? "/acp/v1" : url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
        },
        (res) => {
          let fullText = "";
          let buffer = "";

          // Handle SSE streaming
          if (res.headers["content-type"]?.includes("text/event-stream")) {
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
                  const text = parsed.content?.text || parsed.delta?.text || parsed.text || "";
                  if (text) {
                    fullText += text;
                    onChunk({ type: "text_delta", text });
                  }
                } catch {}
              }
            });
          } else {
            // JSON-RPC response (non-streaming)
            res.on("data", (chunk) => {
              buffer += chunk.toString();
            });
          }

          res.on("end", () => {
            this.abortControllers.delete(sessionId);

            // If non-streaming, parse the full response
            if (!res.headers["content-type"]?.includes("text/event-stream") && buffer) {
              try {
                const parsed = JSON.parse(buffer);
                const result = parsed.result || parsed;
                const text = result.content?.text || result.message?.content?.text || result.text || buffer;
                fullText = typeof text === "string" ? text : JSON.stringify(text);
                onChunk({ type: "text_delta", text: fullText });
              } catch {
                fullText = buffer;
                onChunk({ type: "text_delta", text: fullText });
              }
            }

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

module.exports = { ACPProvider };
