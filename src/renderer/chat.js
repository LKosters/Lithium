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
      // Ordered stream parts: { type: "text", content } or { type: "tool", ... }
      streamParts: [],
      contextUsed: 0,
      contextSize: 0,
      streamStartTime: 0,
      provider: null,
      model: null,
      attachedImages: [],
    });
  }
  return chatStates.get(sessionId);
}

// ── Markdown → HTML ─────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Code blocks
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

  // Strip stray newlines inside lists (prevents <br> gaps between items)
  html = html.replace(/(<\/li>)\n+(<li )/g, "$1$2");
  html = html.replace(/(<ul[^>]*>)\n+/g, "$1");
  html = html.replace(/\n+(<\/ul>)/g, "$1");
  html = html.replace(/(<ol[^>]*>)\n+/g, "$1");
  html = html.replace(/\n+(<\/ol>)/g, "$1");

  // Paragraphs: double newline = paragraph break
  html = html.replace(/\n\n+/g, '</p><p class="chat-p">');
  html = html.replace(/\n/g, "<br>");

  // Wrap in paragraph if we split
  if (html.includes('</p><p class="chat-p">')) {
    html = '<p class="chat-p">' + html + "</p>";
  }

  return html;
}

function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  const s = (ms / 1000).toFixed(1);
  if (s < 60) return s + "s";
  const m = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return m + "m " + sec + "s";
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ── Pane creation ───────────────────────────────────
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
    <button class="chat-scroll-bottom hidden" title="Scroll to bottom">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M8 3v10M8 13l4-4M8 13L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <div class="chat-image-preview-row hidden"></div>
        <div class="chat-input-row">
          <button class="chat-attach-btn" title="Attach image">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M14 8l-5.3 5.3a3.5 3.5 0 01-5-5L9.5 2.5a2.1 2.1 0 013 3L6.7 11.3a.7.7 0 01-1-1L11 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <textarea class="chat-input" placeholder="Ask anything..." rows="1" spellcheck="false"></textarea>
          <button class="chat-send-btn" title="Send">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 14V3M8 3L3 8M8 3l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="chat-stop-btn hidden" title="Stop">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/>
            </svg>
          </button>
          <button class="chat-clear-btn" title="Clear context">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 4h12M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6.5 7v5M9.5 7v5M4 4l.8 9a1 1 0 001 .9h4.4a1 1 0 001-.9L12 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="chat-model-bar">
        <select class="chat-model-select" title="Switch model"></select>
        <span class="chat-context-label hidden"></span>
      </div>
    </div>
  `;

  const inputEl = paneEl.querySelector(".chat-input");
  const sendBtn = paneEl.querySelector(".chat-send-btn");
  const stopBtn = paneEl.querySelector(".chat-stop-btn");
  const clearBtn = paneEl.querySelector(".chat-clear-btn");
  const attachBtn = paneEl.querySelector(".chat-attach-btn");
  const modelSelect = paneEl.querySelector(".chat-model-select");
  const scrollBottomBtn = paneEl.querySelector(".chat-scroll-bottom");
  const messagesContainer = paneEl.querySelector(".chat-messages");

  // Show/hide scroll-to-bottom button based on scroll position
  messagesContainer.addEventListener("scroll", () => {
    const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    scrollBottomBtn.classList.toggle("hidden", distFromBottom < 100);
  });

  scrollBottomBtn.addEventListener("click", () => {
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: "smooth" });
  });

  // Populate model selector with enabled ACPs
  Promise.all([
    app.ipcRenderer.invoke("agent:get-enabled-acps"),
    app.ipcRenderer.invoke("agent:get-provider-labels"),
  ]).then(([enabledACPs, labels]) => {
    modelSelect.innerHTML = enabledACPs
      .map(p => `<option value="${p}">${labels[p] || p}</option>`)
      .join("");

    if (cs.provider && enabledACPs.includes(cs.provider)) {
      modelSelect.value = cs.provider;
    } else if (enabledACPs.length > 0) {
      modelSelect.value = enabledACPs[0];
      cs.provider = enabledACPs[0];
    }
  });

  modelSelect.addEventListener("change", () => {
    cs.provider = modelSelect.value;
    const sessionData = state.sessions.find((s) => s.id === sessionId);
    if (sessionData) {
      sessionData.provider = modelSelect.value;
      app.ipcRenderer.send("sessions:save", sessionData);
    }
  });

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

  // Paste images from clipboard
  inputEl.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          cs.attachedImages.push({ dataUrl: reader.result, mimeType: file.type, name: file.name || "pasted-image" });
          renderImagePreviews(sessionId, paneEl);
        };
        reader.readAsDataURL(file);
      }
    }
  });

  // Attach button — open file picker
  attachBtn.addEventListener("click", async () => {
    const images = await app.ipcRenderer.invoke("dialog:pick-images");
    if (images && images.length > 0) {
      cs.attachedImages.push(...images);
      renderImagePreviews(sessionId, paneEl);
    }
  });

  sendBtn.addEventListener("click", () => sendMessage(sessionId, paneEl));

  stopBtn.addEventListener("click", () => {
    app.ipcRenderer.send("agent:abort", { sessionId, provider: cs.provider });
    // Force end the stream on the UI side
    cs.streaming = false;
    cs.streamParts = [];
    cs.streamStartTime = 0;
    updateStreamUI(sessionId);
    renderMessages(sessionId, paneEl);
  });

  clearBtn.addEventListener("click", () => {
    cs.messages = [];
    cs.streamParts = [];
    cs.streaming = false;
    cs.contextUsed = 0;
    cs.contextSize = 0;
    app.ipcRenderer.send("agent:clear-history", sessionId);
    updateStreamUI(sessionId);
    updateContextBar(sessionId);
    renderMessages(sessionId, paneEl);
  });

  // Load existing history + context usage
  app.ipcRenderer.invoke("agent:history", sessionId).then((data) => {
    if (!data) return;
    // Handle both old format (array) and new format (object)
    const messages = Array.isArray(data) ? data : data.messages;
    if (messages && messages.length > 0) {
      cs.messages = messages;
      if (data.contextUsed) cs.contextUsed = data.contextUsed;
      if (data.contextSize) cs.contextSize = data.contextSize;
      renderMessages(sessionId, paneEl);
      updateContextBar(sessionId);
      // Ensure scroll to bottom after layout settles
      setTimeout(() => {
        const el = paneEl.querySelector(".chat-messages");
        if (el) el.scrollTop = el.scrollHeight;
      }, 50);
    }
  });

  return paneEl;
}

// ── Image previews ──────────────────────────────────
function renderImagePreviews(sessionId, paneEl) {
  const cs = getChatState(sessionId);
  const row = paneEl.querySelector(".chat-image-preview-row");
  if (!row) return;

  row.innerHTML = "";
  if (cs.attachedImages.length === 0) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");

  cs.attachedImages.forEach((img, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "chat-image-thumb-wrap";
    wrap.innerHTML = `<img class="chat-image-thumb" src="${img.dataUrl}" alt="${escapeHtml(img.name)}" title="${escapeHtml(img.name)}"><button class="chat-image-thumb-remove" title="Remove">&times;</button>`;
    wrap.querySelector(".chat-image-thumb-remove").addEventListener("click", () => {
      cs.attachedImages.splice(idx, 1);
      renderImagePreviews(sessionId, paneEl);
    });
    row.appendChild(wrap);
  });
}

// ── Send ────────────────────────────────────────────
function sendMessage(sessionId, paneEl) {
  const cs = getChatState(sessionId);
  if (cs.streaming) return;

  const inputEl = paneEl.querySelector(".chat-input");
  const text = inputEl.value.trim();
  const images = cs.attachedImages.slice();
  if (!text && images.length === 0) return;

  const msg = { role: "user", content: text, timestamp: Date.now() };
  if (images.length > 0) msg.images = images;
  cs.messages.push(msg);

  inputEl.value = "";
  inputEl.style.height = "auto";
  cs.attachedImages = [];
  renderImagePreviews(sessionId, paneEl);

  // Auto-title: use first prompt as session title if still default
  const sessionData = state.sessions.find((s) => s.id === sessionId);
  if (sessionData && text) {
    const defaultTitle = sessionData.directory
      ? require("./helpers").shortDir(sessionData.directory)
      : "";
    const dirName = sessionData.directory
      ? require("path").basename(sessionData.directory)
      : "";
    const isDefault = !sessionData.title
      || sessionData.title === defaultTitle
      || sessionData.title === dirName
      || sessionData.title === "Session";
    if (isDefault) {
      const maxLen = 50;
      sessionData.title = text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
      require("./helpers").persistSession(sessionData);
      if (app.renderSessionList) app.renderSessionList();
      // Update tab title in layout
      const tabEl = document.querySelector(`.pane-tab[data-session-id="${sessionId}"] .pane-tab-title`);
      if (tabEl) tabEl.textContent = sessionData.title;
    }
  }

  renderMessages(sessionId, paneEl);

  const cwd = state.currentDir || null;
  console.log("[chat] Sending message — state.currentDir:", state.currentDir, "cwd:", cwd);

  app.ipcRenderer.send("agent:send", {
    sessionId,
    provider: cs.provider,
    message: text,
    images,
    model: cs.model,
    cwd,
  });
}

// ── Render all messages ─────────────────────────────
function renderMessages(sessionId, paneEl) {
  const cs = getChatState(sessionId);
  const messagesEl = paneEl.querySelector(".chat-messages");

  if (cs.messages.length === 0 && !cs.streaming) {
    messagesEl.innerHTML = "";
    messagesEl.appendChild(createWelcome());
    return;
  }

  messagesEl.innerHTML = "";

  for (const msg of cs.messages) {
    const msgEl = document.createElement("div");
    msgEl.className = `chat-msg chat-msg-${msg.role}`;

    if (msg.role === "user") {
      let imagesHtml = "";
      if (msg.images && msg.images.length > 0) {
        imagesHtml = `<div class="chat-msg-images">${msg.images.map(img => `<img class="chat-msg-image" src="${img.dataUrl}" alt="${escapeHtml(img.name || "image")}">`).join("")}</div>`;
      }
      const textHtml = msg.content ? escapeHtml(msg.content) : "";
      msgEl.innerHTML = `<div class="chat-msg-content chat-msg-content-user">${imagesHtml}${textHtml}</div>`;
    } else {
      let statsHtml = "";
      if (msg.duration || msg.contextUsed) {
        const parts = [];
        if (msg.duration) parts.push(formatDuration(msg.duration));
        if (msg.contextUsed && msg.contextSize) {
          const pct = Math.round((msg.contextUsed / msg.contextSize) * 100);
          parts.push(`${formatTokens(msg.contextUsed)} tokens (${pct}%)`);
        }
        statsHtml = `<div class="chat-msg-stats">${parts.join(" · ")}</div>`;
      }
      msgEl.innerHTML = `<div class="chat-msg-content chat-msg-content-assistant">${renderMarkdown(msg.content)}</div>${statsHtml}`;
    }

    messagesEl.appendChild(msgEl);
  }

  if (cs.streaming) {
    renderStreamInline(cs, messagesEl, sessionId);
  }

  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// ── Render streaming content inline ─────────────────
function renderStreamInline(cs, container, sessionId) {
  if (cs.streamParts.length === 0) {
    // Nothing yet — show typing dots
    const el = document.createElement("div");
    el.className = "chat-msg chat-msg-assistant";
    el.innerHTML = `<div class="chat-msg-content chat-msg-content-assistant chat-stream-content"><span class="chat-typing"><span></span><span></span><span></span></span></div>`;
    container.appendChild(el);
    return;
  }

  for (const part of cs.streamParts) {
    if (part.type === "text" && part.content) {
      const el = document.createElement("div");
      el.className = "chat-msg chat-msg-assistant";
      el.innerHTML = `<div class="chat-msg-content chat-msg-content-assistant chat-stream-text">${renderMarkdown(part.content)}</div>`;
      container.appendChild(el);
    } else if (part.type === "permission") {
      const el = document.createElement("div");
      el.className = "chat-tool-approval" + (part.resolved ? " resolved" : "");
      el.dataset.permissionId = part.permissionId;

      const shieldIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1L2 4v4c0 3.3 2.6 6.4 6 7 3.4-.6 6-3.7 6-7V4L8 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
      let actionsHtml;
      if (part.resolved) {
        const label = part.result === "allowed" ? "Allowed" : "Denied";
        actionsHtml = `<span class="chat-tool-approval-result">${label}</span>`;
      } else {
        actionsHtml = `<div class="chat-tool-approval-actions">
          <button class="chat-tool-approval-allow-always" title="Allow this tool for the entire project">Always</button>
          <button class="chat-tool-approval-allow">Allow</button>
          <button class="chat-tool-approval-deny">Deny</button>
        </div>`;
      }

      const descHtml = part.description
        ? `<pre class="chat-tool-approval-code">${escapeHtml(part.description)}</pre>`
        : "";

      el.innerHTML = `<div class="chat-tool-approval-info">${shieldIcon}<span class="chat-tool-approval-title">${escapeHtml(part.title)}</span></div>
        ${descHtml}
        ${actionsHtml}`;

      if (!part.resolved) {
        const alwaysBtn = el.querySelector(".chat-tool-approval-allow-always");
        const allowBtn = el.querySelector(".chat-tool-approval-allow");
        const denyBtn = el.querySelector(".chat-tool-approval-deny");

        alwaysBtn.addEventListener("click", () => {
          const allowOpt = part.options.find(o => o.kind === "allow_always")
            || part.options.find(o => o.kind === "allow_once")
            || part.options[0];
          const optionId = allowOpt ? allowOpt.optionId : "allow_once";
          part.resolved = true;
          part.result = "allowed";
          app.ipcRenderer.send("agent:permission-response", {
            permissionId: part.permissionId,
            optionId,
            provider: cs.provider,
            alwaysAllow: true,
          });
          const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
          if (paneEl) renderMessages(sessionId, paneEl);
        });

        allowBtn.addEventListener("click", () => {
          const allowOpt = part.options.find(o => o.kind === "allow_always")
            || part.options.find(o => o.kind === "allow_once")
            || part.options[0];
          const optionId = allowOpt ? allowOpt.optionId : "allow_once";
          part.resolved = true;
          part.result = "allowed";
          app.ipcRenderer.send("agent:permission-response", {
            permissionId: part.permissionId,
            optionId,
            provider: cs.provider,
          });
          const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
          if (paneEl) renderMessages(sessionId, paneEl);
        });

        denyBtn.addEventListener("click", () => {
          const denyOpt = part.options.find(o => o.kind === "deny")
            || part.options[part.options.length - 1];
          const optionId = denyOpt ? denyOpt.optionId : "deny";
          part.resolved = true;
          part.result = "denied";
          app.ipcRenderer.send("agent:permission-response", {
            permissionId: part.permissionId,
            optionId,
            provider: cs.provider,
          });
          const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
          if (paneEl) renderMessages(sessionId, paneEl);
        });
      }

      container.appendChild(el);
    } else if (part.type === "tool") {
      const el = document.createElement("div");
      el.className = "chat-tool-call" + (part.status === "completed" ? " done" : " active");
      el.innerHTML = `${getToolIcon(part.kind)}<span class="chat-tool-title">${escapeHtml(part.title)}</span>`;
      container.appendChild(el);
    }
  }

  // Show typing dots if the last part is a tool call (agent is working)
  // Don't show dots if agent is waiting for permission approval
  const lastPart = cs.streamParts[cs.streamParts.length - 1];
  const hasPendingPermission = lastPart && lastPart.type === "permission" && !lastPart.resolved;
  if (lastPart && lastPart.type === "tool" && !hasPendingPermission) {
    const el = document.createElement("div");
    el.className = "chat-msg chat-msg-assistant";
    el.innerHTML = `<div class="chat-msg-content chat-msg-content-assistant"><span class="chat-typing"><span></span><span></span><span></span></span></div>`;
    container.appendChild(el);
  }
}

function createWelcome() {
  const el = document.createElement("div");
  el.className = "chat-welcome";
  el.innerHTML = `<p class="chat-welcome-sub">Ask anything</p>`;
  return el;
}

// ── Stream handlers ─────────────────────────────────
function handleStreamStart(sessionId) {
  const cs = getChatState(sessionId);
  cs.streaming = true;
  cs.streamParts = [];
  cs.streamStartTime = Date.now();
  updateStreamUI(sessionId);
}

function handleChunk(sessionId, chunk) {
  const cs = getChatState(sessionId);

  if (chunk.type === "usage") {
    cs.contextUsed = chunk.used;
    cs.contextSize = chunk.size;
    updateContextBar(sessionId);
    return;
  }

  if (chunk.type === "permission_request") {
    cs.streamParts.push({
      type: "permission",
      permissionId: chunk.permissionId,
      title: chunk.title,
      description: chunk.description,
      options: chunk.options,
      resolved: false,
      result: null,
    });
    const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
    if (paneEl) renderMessages(sessionId, paneEl);
    return;
  }

  if (chunk.type === "tool_call") {
    // Update existing tool call or add new one
    const existing = cs.streamParts.find(
      p => p.type === "tool" && p.toolCallId === chunk.toolCallId
    );
    if (existing) {
      existing.title = chunk.title;
      existing.status = chunk.status;
    } else {
      cs.streamParts.push({
        type: "tool",
        toolCallId: chunk.toolCallId,
        title: chunk.title,
        status: chunk.status,
        kind: chunk.kind,
      });
    }
  } else if (chunk.text) {
    // Append to the last text part, or create a new one
    const last = cs.streamParts[cs.streamParts.length - 1];
    if (last && last.type === "text") {
      last.content += chunk.text;
    } else {
      cs.streamParts.push({ type: "text", content: chunk.text });
    }
  }

  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (!paneEl) return;

  // Fast-path: update the last stream text element directly
  if (chunk.text) {
    const textEls = paneEl.querySelectorAll(".chat-stream-text");
    const lastTextEl = textEls[textEls.length - 1];
    if (lastTextEl) {
      const last = cs.streamParts.filter(p => p.type === "text").pop();
      if (last) {
        lastTextEl.innerHTML = renderMarkdown(last.content);
        const messagesEl = paneEl.querySelector(".chat-messages");
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return;
      }
    }
  }

  // Full re-render for tool calls or first text chunk
  renderMessages(sessionId, paneEl);
}

function handleStreamEnd(sessionId, aborted) {
  const cs = getChatState(sessionId);
  if (!aborted) {
    const fullText = cs.streamParts
      .filter(p => p.type === "text")
      .map(p => p.content)
      .join("");
    if (fullText) {
      const duration = cs.streamStartTime ? Date.now() - cs.streamStartTime : 0;
      cs.messages.push({
        role: "assistant",
        content: fullText,
        timestamp: Date.now(),
        duration,
        contextUsed: cs.contextUsed,
        contextSize: cs.contextSize,
      });
    }
  }
  cs.streaming = false;
  cs.streamParts = [];
  cs.streamStartTime = 0;
  updateStreamUI(sessionId);

  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (paneEl) renderMessages(sessionId, paneEl);
}

function handleError(sessionId, error) {
  const cs = getChatState(sessionId);
  cs.streaming = false;
  cs.streamParts = [];
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

// ── UI state ────────────────────────────────────────
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

// ── Context usage ───────────────────────────────────
function updateContextBar(sessionId) {
  const cs = getChatState(sessionId);
  const paneEl = document.querySelector(`.chat-pane[data-session-id="${sessionId}"]`);
  if (!paneEl) return;

  const label = paneEl.querySelector(".chat-context-label");
  if (!label) return;

  if (cs.contextSize > 0) {
    const pct = Math.round((cs.contextUsed / cs.contextSize) * 100);
    label.classList.remove("hidden");
    label.textContent = `Context: ${pct}%`;

    if (pct > 80) {
      label.style.color = "var(--destructive)";
    } else if (pct > 50) {
      label.style.color = "var(--primary)";
    } else {
      label.style.color = "";
    }
  }
}

// ── Tool call icons ─────────────────────────────────
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

// ── Provider helpers ────────────────────────────────
function getProviderIcon(provider) {
  switch (provider) {
    case "acp":
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="4" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 6v2M6.3 10.3L7 8.5M9.7 10.3L9 8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
    case "cursor-acp":
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2l10 6-4 1.5L7.5 14 6.5 9 3 2z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
    default:
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/></svg>`;
  }
}

// Provider labels are fetched from the registry and cached
let _providerLabels = null;
function getProviderLabel(provider) {
  if (provider === "terminal") return "Terminal";
  if (_providerLabels && _providerLabels[provider]) return _providerLabels[provider];
  return provider;
}

// Load labels from registry on init
app.ipcRenderer.invoke("agent:get-provider-labels").then((labels) => {
  _providerLabels = labels;
});

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
