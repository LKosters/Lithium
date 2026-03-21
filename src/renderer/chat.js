// Chat UI — renders a real chat window with message bubbles, markdown, and input
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
      provider: null,
      model: null,
    });
  }
  return chatStates.get(sessionId);
}

// Simple markdown → HTML (code blocks, inline code, bold, italic, links, lists)
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Code blocks with language tag
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="chat-code-lang">${lang}</span>` : "";
    return `<div class="chat-code-block">${langLabel}<pre><code>${code}</code></pre></div>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4 class="chat-h">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="chat-h">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="chat-h">$1</h2>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li class="chat-li">$1</li>');
  html = html.replace(/((?:<li class="chat-li">.*<\/li>\n?)+)/g, '<ul class="chat-ul">$1</ul>');

  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="chat-li-num">$1</li>');
  html = html.replace(/((?:<li class="chat-li-num">.*<\/li>\n?)+)/g, '<ol class="chat-ol">$1</ol>');

  // Line breaks (not inside code blocks)
  html = html.replace(/\n/g, "<br>");

  return html;
}

function createChatPane(sessionId, provider, model) {
  const cs = getChatState(sessionId);
  cs.provider = provider || "claude";
  cs.model = model || null;

  const paneEl = document.createElement("div");
  paneEl.className = "chat-pane";
  paneEl.dataset.sessionId = sessionId;

  paneEl.innerHTML = `
    <div class="chat-header">
      <div class="chat-provider-badge" data-provider="${escapeHtml(cs.provider)}">
        <span class="chat-provider-icon">${getProviderIcon(cs.provider)}</span>
        <span class="chat-provider-name">${escapeHtml(getProviderLabel(cs.provider))}</span>
        ${cs.model ? `<span class="chat-model-tag">${escapeHtml(cs.model)}</span>` : ""}
      </div>
      <div class="chat-header-actions">
        <button class="chat-header-btn chat-btn-clear" title="Clear chat">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="chat-messages">
      <div class="chat-welcome">
        <div class="chat-welcome-icon">${getProviderIcon(cs.provider)}</div>
        <h3 class="chat-welcome-title">Chat with ${escapeHtml(getProviderLabel(cs.provider))}</h3>
        <p class="chat-welcome-sub">Send a message to start a conversation</p>
      </div>
    </div>
    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea class="chat-input" placeholder="Send a message..." rows="1" spellcheck="false"></textarea>
        <button class="chat-send-btn" title="Send (Enter)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M14 2L7 9M14 2l-4.5 12-2-5.5L2 6.5 14 2z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="chat-stop-btn hidden" title="Stop generating">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/>
          </svg>
        </button>
      </div>
      <div class="chat-input-hint">
        <span>Enter to send</span>
        <span>Shift+Enter for new line</span>
      </div>
    </div>
  `;

  // Wire events
  const messagesEl = paneEl.querySelector(".chat-messages");
  const inputEl = paneEl.querySelector(".chat-input");
  const sendBtn = paneEl.querySelector(".chat-send-btn");
  const stopBtn = paneEl.querySelector(".chat-stop-btn");
  const clearBtn = paneEl.querySelector(".chat-btn-clear");

  // Auto-resize textarea
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  });

  // Send on Enter (not Shift+Enter)
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

  clearBtn.addEventListener("click", () => {
    cs.messages = [];
    app.ipcRenderer.send("agent:clear-history", sessionId);
    renderMessages(sessionId, paneEl);
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

  // Add user message
  cs.messages.push({ role: "user", content: text, timestamp: Date.now() });
  inputEl.value = "";
  inputEl.style.height = "auto";

  renderMessages(sessionId, paneEl);

  // Send to main process
  app.ipcRenderer.send("agent:send", {
    sessionId,
    provider: cs.provider,
    message: text,
    model: cs.model,
  });
}

function renderMessages(sessionId, paneEl) {
  const cs = getChatState(sessionId);
  const messagesEl = paneEl.querySelector(".chat-messages");
  const welcomeEl = messagesEl.querySelector(".chat-welcome");

  if (cs.messages.length === 0) {
    messagesEl.innerHTML = "";
    messagesEl.appendChild(createWelcome(cs.provider));
    return;
  }

  if (welcomeEl) welcomeEl.remove();

  // Remove all existing message elements and re-render
  messagesEl.innerHTML = "";

  for (const msg of cs.messages) {
    const msgEl = document.createElement("div");
    msgEl.className = `chat-message chat-message-${msg.role}`;

    if (msg.role === "user") {
      msgEl.innerHTML = `
        <div class="chat-bubble chat-bubble-user">
          <div class="chat-bubble-content">${escapeHtml(msg.content)}</div>
        </div>
      `;
    } else {
      msgEl.innerHTML = `
        <div class="chat-bubble chat-bubble-assistant">
          <div class="chat-avatar">${getProviderIcon(cs.provider)}</div>
          <div class="chat-bubble-content">${renderMarkdown(msg.content)}</div>
        </div>
      `;
    }

    messagesEl.appendChild(msgEl);
  }

  // If streaming, add a streaming indicator
  if (cs.streaming) {
    const streamEl = document.createElement("div");
    streamEl.className = "chat-message chat-message-assistant";
    streamEl.innerHTML = `
      <div class="chat-bubble chat-bubble-assistant streaming">
        <div class="chat-avatar">${getProviderIcon(cs.provider)}</div>
        <div class="chat-bubble-content chat-stream-content">${renderMarkdown(cs.streamBuffer) || '<span class="chat-typing"><span></span><span></span><span></span></span>'}</div>
      </div>
    `;
    messagesEl.appendChild(streamEl);
  }

  // Scroll to bottom
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function createWelcome(provider) {
  const el = document.createElement("div");
  el.className = "chat-welcome";
  el.innerHTML = `
    <div class="chat-welcome-icon">${getProviderIcon(provider)}</div>
    <h3 class="chat-welcome-title">Chat with ${escapeHtml(getProviderLabel(provider))}</h3>
    <p class="chat-welcome-sub">Send a message to start a conversation</p>
  `;
  return el;
}

function handleStreamStart(sessionId) {
  const cs = getChatState(sessionId);
  cs.streaming = true;
  cs.streamBuffer = "";
  updateStreamUI(sessionId);
}

function handleChunk(sessionId, chunk) {
  const cs = getChatState(sessionId);
  if (chunk.text) {
    cs.streamBuffer += chunk.text;
  }
  // Update just the stream content element for performance
  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (paneEl) {
    const streamContent = paneEl.querySelector(".chat-stream-content");
    if (streamContent) {
      streamContent.innerHTML = renderMarkdown(cs.streamBuffer);
      const messagesEl = paneEl.querySelector(".chat-messages");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      renderMessages(sessionId, paneEl);
    }
  }
}

function handleStreamEnd(sessionId, aborted) {
  const cs = getChatState(sessionId);
  if (!aborted && cs.streamBuffer) {
    cs.messages.push({ role: "assistant", content: cs.streamBuffer, timestamp: Date.now() });
  }
  cs.streaming = false;
  cs.streamBuffer = "";
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
    inputEl.placeholder = "Waiting for response...";
  } else {
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    inputEl.disabled = false;
    inputEl.placeholder = "Send a message...";
    inputEl.focus();
  }
}

function getProviderIcon(provider) {
  switch (provider) {
    case "claude":
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 6.5c0-.8.7-1.5 1.5-1.5h2c.8 0 1.5.7 1.5 1.5v3c0 .8-.7 1.5-1.5 1.5H7c-.8 0-1.5-.7-1.5-1.5v-3z" fill="currentColor" opacity="0.3"/><circle cx="6.5" cy="7" r="0.7" fill="currentColor"/><circle cx="9.5" cy="7" r="0.7" fill="currentColor"/></svg>`;
    case "codex":
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.3"/><path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.6"/></svg>`;
    case "acp":
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="4" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 6v2M6.3 10.3L7 8.5M9.7 10.3L9 8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
    default:
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/></svg>`;
  }
}

function getProviderLabel(provider) {
  switch (provider) {
    case "claude": return "Claude";
    case "codex": return "ChatGPT Codex";
    case "acp": return "ACP Agent";
    case "terminal": return "Claude Code";
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
