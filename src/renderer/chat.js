// Chat UI — renders a chat pane with messages, markdown, and input
const app = require("./app");
const { state } = require("./state");
const { escapeHtml } = require("./helpers");

// Per-session chat state
const chatStates = new Map();

function getChatState(sessionId) {
  if (!chatStates.has(sessionId)) {
    chatStates.set(sessionId, {
      messages: [],
      streaming: false,
      streamBuffer: "",
      toolCalls: [],        // active tool calls during stream
      provider: null,
      model: null,
    });
  }
  return chatStates.get(sessionId);
}

// Simple markdown → HTML
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="chat-code-lang">${lang}</span>` : "";
    return `<div class="chat-code-block">${langLabel}<pre><code>${code}</code></pre></div>`;
  });

  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/^### (.+)$/gm, '<h4 class="chat-h">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="chat-h">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="chat-h">$1</h2>');
  html = html.replace(/^[*-] (.+)$/gm, '<li class="chat-li">$1</li>');
  html = html.replace(/((?:<li class="chat-li">.*<\/li>\n?)+)/g, '<ul class="chat-ul">$1</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="chat-li-num">$1</li>');
  html = html.replace(/((?:<li class="chat-li-num">.*<\/li>\n?)+)/g, '<ol class="chat-ol">$1</ol>');
  html = html.replace(/\n/g, "<br>");

  return html;
}

function createChatPane(sessionId, provider, model) {
  const cs = getChatState(sessionId);
  cs.provider = provider || "terminal";
  cs.model = model || null;

  const paneEl = document.createElement("div");
  paneEl.className = "chat-pane";
  paneEl.dataset.sessionId = sessionId;

  paneEl.innerHTML = `
    <div class="chat-messages">
      <div class="chat-welcome">
        <p class="chat-welcome-sub">Ask anything</p>
      </div>
    </div>
    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea class="chat-input" placeholder="Ask anything..." rows="1" spellcheck="false"></textarea>
        <button class="chat-send-btn" title="Send">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 13V8.5L13 8M3 3v4.5L13 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="chat-stop-btn hidden" title="Stop">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  const inputEl = paneEl.querySelector(".chat-input");
  const sendBtn = paneEl.querySelector(".chat-send-btn");
  const stopBtn = paneEl.querySelector(".chat-stop-btn");

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(sessionId, paneEl);
    }
  });

  sendBtn.addEventListener("click", () => sendMessage(sessionId, paneEl));

  stopBtn.addEventListener("click", () => {
    app.ipcRenderer.send("agent:abort", { sessionId, provider: cs.provider });
  });

  // Load existing history
  app.ipcRenderer.invoke("agent:history", sessionId).then((history) => {
    if (history && history.length > 0) {
      cs.messages = history;
      renderMessages(sessionId, paneEl);
    }
  });

  return paneEl;
}

function sendMessage(sessionId, paneEl) {
  const cs = getChatState(sessionId);
  if (cs.streaming) return;

  const inputEl = paneEl.querySelector(".chat-input");
  const text = inputEl.value.trim();
  if (!text) return;

  cs.messages.push({ role: "user", content: text, timestamp: Date.now() });
  inputEl.value = "";
  inputEl.style.height = "auto";

  renderMessages(sessionId, paneEl);

  const sessionData = state.sessions.find((s) => s.id === sessionId);
  const cwd = sessionData?.directory || null;

  app.ipcRenderer.send("agent:send", {
    sessionId,
    provider: cs.provider,
    message: text,
    model: cs.model,
    cwd,
  });
}

function renderMessages(sessionId, paneEl) {
  const cs = getChatState(sessionId);
  const messagesEl = paneEl.querySelector(".chat-messages");

  if (cs.messages.length === 0) {
    messagesEl.innerHTML = "";
    messagesEl.appendChild(createWelcome());
    return;
  }

  messagesEl.innerHTML = "";

  for (const msg of cs.messages) {
    const msgEl = document.createElement("div");
    msgEl.className = `chat-msg chat-msg-${msg.role}`;

    if (msg.role === "user") {
      msgEl.innerHTML = `<div class="chat-msg-content chat-msg-content-user">${escapeHtml(msg.content)}</div>`;
    } else {
      msgEl.innerHTML = `<div class="chat-msg-content chat-msg-content-assistant">${renderMarkdown(msg.content)}</div>`;
    }

    messagesEl.appendChild(msgEl);
  }

  if (cs.streaming) {
    const streamEl = document.createElement("div");
    streamEl.className = "chat-msg chat-msg-assistant";
    streamEl.innerHTML = `<div class="chat-msg-content chat-msg-content-assistant chat-stream-content">${renderStreamContent(cs)}</div>`;
    messagesEl.appendChild(streamEl);
  }

  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function createWelcome() {
  const el = document.createElement("div");
  el.className = "chat-welcome";
  el.innerHTML = `<p class="chat-welcome-sub">Ask anything</p>`;
  return el;
}

function handleStreamStart(sessionId) {
  const cs = getChatState(sessionId);
  cs.streaming = true;
  cs.streamBuffer = "";
  cs.toolCalls = [];
  updateStreamUI(sessionId);
}

function handleChunk(sessionId, chunk) {
  const cs = getChatState(sessionId);

  if (chunk.type === "tool_call") {
    // Track tool calls — update existing or add new
    const existing = cs.toolCalls.find(t => t.toolCallId === chunk.toolCallId);
    if (existing) {
      existing.title = chunk.title;
      existing.status = chunk.status;
    } else {
      cs.toolCalls.push({
        toolCallId: chunk.toolCallId,
        title: chunk.title,
        status: chunk.status,
        kind: chunk.kind,
      });
    }
  } else if (chunk.text) {
    cs.streamBuffer += chunk.text;
  }

  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (paneEl) {
    const streamContent = paneEl.querySelector(".chat-stream-content");
    if (streamContent) {
      streamContent.innerHTML = renderStreamContent(cs);
      const messagesEl = paneEl.querySelector(".chat-messages");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      renderMessages(sessionId, paneEl);
    }
  }
}

function renderToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return "";
  return toolCalls.map(tc => {
    const icon = getToolIcon(tc.kind);
    const statusClass = tc.status === "completed" ? "done" : "active";
    return `<div class="chat-tool-call ${statusClass}">${icon}<span class="chat-tool-title">${escapeHtml(tc.title)}</span></div>`;
  }).join("");
}

function getToolIcon(kind) {
  switch (kind) {
    case "edit":
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    case "read":
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 3h8l2 2v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 7h4M5 9.5h6" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>';
    case "command":
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4l4 4-4 4M9 12h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    default:
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3l2 1.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
}

function renderStreamContent(cs) {
  const text = renderMarkdown(cs.streamBuffer);
  const tools = renderToolCalls(cs.toolCalls);

  if (!text && !tools) {
    return '<span class="chat-typing"><span></span><span></span><span></span></span>';
  }

  // Show text, then active tool calls with pulse
  let html = text || "";
  if (tools) {
    html += tools;
  }

  // If there are active (non-completed) tool calls, show pulse
  const hasActive = cs.toolCalls.some(t => t.status !== "completed");
  if (hasActive) {
    html += '<div class="chat-pulse"><span></span></div>';
  }

  return html;
}

function handleStreamEnd(sessionId, aborted) {
  const cs = getChatState(sessionId);
  if (!aborted && cs.streamBuffer) {
    cs.messages.push({ role: "assistant", content: cs.streamBuffer, timestamp: Date.now() });
  }
  cs.streaming = false;
  cs.streamBuffer = "";
  cs.toolCalls = [];
  updateStreamUI(sessionId);

  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (paneEl) renderMessages(sessionId, paneEl);
}

function handleError(sessionId, error) {
  const cs = getChatState(sessionId);
  cs.streaming = false;
  cs.streamBuffer = "";
  updateStreamUI(sessionId);

  cs.messages.push({
    role: "assistant",
    content: `**Error:** ${error}`,
    timestamp: Date.now(),
    isError: true,
  });

  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (paneEl) renderMessages(sessionId, paneEl);
}

function updateStreamUI(sessionId) {
  const cs = getChatState(sessionId);
  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (!paneEl) return;

  const sendBtn = paneEl.querySelector(".chat-send-btn");
  const stopBtn = paneEl.querySelector(".chat-stop-btn");
  const inputEl = paneEl.querySelector(".chat-input");

  if (cs.streaming) {
    sendBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    inputEl.disabled = true;
    inputEl.placeholder = "Generating...";
  } else {
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    inputEl.disabled = false;
    inputEl.placeholder = "Ask anything...";
    inputEl.focus();
  }
}

function getProviderIcon(provider) {
  switch (provider) {
    case "acp":
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="4" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 6v2M6.3 10.3L7 8.5M9.7 10.3L9 8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
    default:
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/></svg>`;
  }
}

function getProviderLabel(provider) {
  switch (provider) {
    case "acp": return "Codex";
    case "terminal": return "Terminal";
    default: return provider;
  }
}

function deleteChatState(sessionId) {
  chatStates.delete(sessionId);
}

module.exports = {
  createChatPane,
  getChatState,
  deleteChatState,
  handleStreamStart,
  handleChunk,
  handleStreamEnd,
  handleError,
  getProviderIcon,
  getProviderLabel,
  chatStates,
};
