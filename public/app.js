const STORAGE_KEY = "simple-llm-chat-v1";

const ICONS = {
  plus: `<path d="M12 5v14M5 12h14"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>`,
  message: `<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/>`,
  dots: `<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>`,
  chevron: `<path d="m9 18 6-6-6-6"/>`,
  panel: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>`,
  send: `<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>`,
  sparkles: `<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z"/><path d="m19 14 .7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7Z"/><path d="m5 15 .7 1.3L7 17l-1.3.7L5 19l-.7-1.3L3 17l1.3-.7Z"/>`,
  pen: `<path d="m15 5 4 4L8 20l-5 1 1-5Z"/><path d="m13 7 4 4"/>`,
  code: `<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>`,
  bulb: `<path d="M9 18h6M10 22h4"/><path d="M8.5 15.5C6.9 14.4 6 12.6 6 10.5a6 6 0 1 1 12 0c0 2.1-.9 3.9-2.5 5-.9.7-1.2 1.4-1.2 2.5h-4.6c0-1.1-.3-1.8-1.2-2.5Z"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  close: `<path d="M18 6 6 18M6 6l12 12"/>`,
  stop: `<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>`,
};

const SUGGESTIONS = [
  { icon: "sparkles", title: "帮我整理思路", description: "把零散想法变成清晰的行动计划", prompt: "帮我把一个新项目的零散想法整理成清晰的行动计划。" },
  { icon: "pen", title: "润色一段文字", description: "让表达更自然、简洁、有说服力", prompt: "请帮我润色一段文字，让表达更自然、简洁。" },
  { icon: "code", title: "解释代码", description: "用容易理解的方式拆解复杂逻辑", prompt: "请用简单易懂的方式帮我解释一段代码。" },
  { icon: "bulb", title: "头脑风暴", description: "从不同角度生成创意与灵感", prompt: "和我一起进行头脑风暴，给我一些有创意的新方向。" },
];

const gate = document.querySelector("#gate");
const app = document.querySelector("#app");
const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const loginError = document.querySelector("#login-error");
const history = document.querySelector("#history");
const historySearch = document.querySelector("#history-search");
const historyQuery = document.querySelector("#history-query");
const conversationEl = document.querySelector("#conversation");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const chatError = document.querySelector("#chat-error");
const sidebar = document.querySelector("#sidebar");
const backdrop = document.querySelector("#sidebar-backdrop");

let state = loadState();
let streaming = false;
let searching = false;
let abortController = null;

function icon(name, size = 20, strokeWidth = 1.8) {
  return `<svg aria-hidden="true" fill="none" width="${size}" height="${size}" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth}">${ICONS[name]}</svg>`;
}

function mountIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => {
    node.innerHTML = icon(node.dataset.icon, Number(node.dataset.size || 20), Number(node.dataset.stroke || 1.8));
  });
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (saved && Array.isArray(saved.conversations)) return saved;
  } catch {
    // A broken local record should not block a new conversation.
  }
  return { activeId: null, conversations: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) ?? null;
}

function createConversation() {
  const current = activeConversation();
  if (current && current.messages.length === 0) return current;
  const conversation = { id: crypto.randomUUID(), title: "新对话", updatedAt: Date.now(), messages: [] };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  saveState();
  return conversation;
}

function ensureConversation() {
  return activeConversation() ?? createConversation();
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

async function request(path, options = {}) {
  return fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
}

let virtualKeyboardHeight = 0;

function fitVisibleViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const offset = viewport ? viewport.offsetTop : 0;
  const fromViewport = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  const keyboard = Math.max(fromViewport, virtualKeyboardHeight);
  root.style.setProperty("--vv-offset", `${offset}px`);
  root.style.setProperty("--keyboard-bottom", `${keyboard}px`);
  root.classList.toggle("keyboard-open", keyboard > 40);
  if (keyboard > 40) {
    const conversation = document.querySelector("#conversation");
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }
}

function holdViewportStill() {
  fitVisibleViewport();
  requestAnimationFrame(fitVisibleViewport);
  window.setTimeout(fitVisibleViewport, 80);
  window.setTimeout(fitVisibleViewport, 320);
}

if (window.visualViewport) {
  visualViewport.addEventListener("resize", holdViewportStill);
  visualViewport.addEventListener("scroll", holdViewportStill);
  holdViewportStill();
}

if (navigator.virtualKeyboard) {
  navigator.virtualKeyboard.overlaysContent = true;
  navigator.virtualKeyboard.addEventListener("geometrychange", () => {
    virtualKeyboardHeight = navigator.virtualKeyboard.boundingRect.height || 0;
    fitVisibleViewport();
  });
}

function focusField(element) {
  if (window.matchMedia("(pointer: coarse)").matches) return;
  element.focus();
}

function showGate() {
  closeSidebar();
  searching = false;
  gate.hidden = false;
  gate.inert = false;
  app.hidden = true;
  app.inert = true;
  fitVisibleViewport();
  focusField(passwordInput);
}

function showApp({ fresh = false } = {}) {
  closeSidebar();
  searching = false;
  gate.hidden = true;
  gate.inert = true;
  app.hidden = false;
  app.inert = false;
  fitVisibleViewport();
  if (fresh || !activeConversation()) createConversation();
  render();
  focusField(messageInput);
}

function render() {
  const conversation = ensureConversation();
  renderHistory(conversation);
  renderConversation(conversation);
  updateSendButton();
}

function renderHistory(conversation) {
  const query = historyQuery.value.trim().toLowerCase();
  historySearch.hidden = !searching;
  history.innerHTML = "";
  const items = state.conversations.filter((item) => item.title.toLowerCase().includes(query));
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = query ? "没有匹配的对话" : "还没有对话";
    history.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = `history-item${item.id === conversation.id ? " active" : ""}`;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    open.innerHTML = icon("message", 17);
    const title = document.createElement("span");
    title.textContent = item.title;
    open.append(title);
    open.addEventListener("click", () => {
      if (streaming) return;
      state.activeId = item.id;
      saveState();
      closeSidebar();
      render();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-delete";
    remove.setAttribute("aria-label", `删除${item.title}`);
    remove.innerHTML = icon("dots", 17);
    remove.addEventListener("click", () => deleteConversation(item.id));
    row.append(open, remove);
    history.append(row);
  }
}

function renderConversation(conversation) {
  conversationEl.innerHTML = "";
  if (conversation.messages.length === 0) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = `
      <div class="welcome-mark">${icon("sparkles", 24, 1.7)}</div>
      <p class="eyebrow">你的 AI 思考伙伴</p>
      <h1>${greeting()}<br><span>今天想一起探索什么？</span></h1>
      <div class="suggestion-grid"></div>
    `;
    const grid = welcome.querySelector(".suggestion-grid");
    for (const item of SUGGESTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion-card";
      button.innerHTML = `<span class="suggestion-icon">${icon(item.icon, 19)}</span><span><strong></strong><small></small></span>${icon("chevron", 17)}`;
      button.querySelector("strong").textContent = item.title;
      button.querySelector("small").textContent = item.description;
      button.addEventListener("click", () => sendMessage(item.prompt));
      grid.append(button);
    }
    conversationEl.append(welcome);
    return;
  }

  const list = document.createElement("div");
  list.className = "message-list";
  const heading = document.createElement("div");
  heading.className = "conversation-heading";
  const title = document.createElement("p");
  title.textContent = conversation.title;
  const model = document.createElement("span");
  model.textContent = "Qwen 3.8";
  heading.append(title, model);
  list.append(heading);
  conversation.messages.forEach((message, index) => {
    const pending = streaming && index === conversation.messages.length - 1 && message.role === "assistant" && !message.content;
    list.append(renderMessage(message, pending));
  });
  conversationEl.append(list);
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function renderMessage(message, pending) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.innerHTML = icon(message.role === "assistant" ? "sparkles" : "user", 17);
  const body = document.createElement("div");
  const author = document.createElement("p");
  author.className = "message-author";
  author.textContent = message.role === "assistant" ? "Nova" : "你";
  body.append(author);
  if (pending) {
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.setAttribute("aria-label", "正在思考");
    typing.innerHTML = "<span></span><span></span><span></span>";
    body.append(typing);
  } else {
    const content = document.createElement("p");
    content.className = "message-content";
    content.textContent = message.content;
    body.append(content);
  }
  article.append(avatar, body);
  return article;
}

function updateSendButton() {
  if (streaming) {
    sendButton.disabled = false;
    sendButton.setAttribute("aria-label", "停止");
    sendButton.innerHTML = icon("stop", 18, 2);
    return;
  }
  sendButton.disabled = messageInput.value.trim() === "";
  sendButton.setAttribute("aria-label", "发送消息");
  sendButton.innerHTML = icon("send", 18, 2);
}

function resizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 130)}px`;
}

async function sendMessage(text) {
  const content = text.trim();
  if (!content || streaming) return;
  const conversation = ensureConversation();
  conversation.messages.push({ role: "user", content });
  if (conversation.title === "新对话") conversation.title = content.replace(/\s+/g, " ").slice(0, 24);
  conversation.updatedAt = Date.now();
  conversation.messages.push({ role: "assistant", content: "" });
  saveState();
  messageInput.value = "";
  resizeInput();
  chatError.textContent = "";
  streaming = true;
  render();

  abortController = new AbortController();
  const assistant = conversation.messages.at(-1);

  try {
    const response = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: conversation.messages.slice(0, -1).map(({ role, content: textContent }) => ({ role, content: textContent })),
      }),
      signal: abortController.signal,
    });

    if (response.status === 401) {
      conversation.messages.splice(-2, 2);
      saveState();
      showGate();
      return;
    }

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "模型暂时不可用");
    }

    await readStream(response.body, (delta) => {
      assistant.content += delta;
      let node = conversationEl.querySelector(".message.assistant:last-child .message-content");
      if (!node) {
        const body = conversationEl.querySelector(".message.assistant:last-child div:last-child");
        if (!body) return;
        body.querySelector(".typing")?.remove();
        node = document.createElement("p");
        node.className = "message-content";
        body.append(node);
      }
      node.textContent = assistant.content;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    });

    if (!assistant.content.trim()) assistant.content = "模型没有返回内容。";
  } catch (error) {
    if (error.name !== "AbortError") {
      chatError.textContent = error.message || "发送失败";
      if (!assistant.content) assistant.content = "这次没有收到回复。";
    } else if (!assistant.content) {
      assistant.content = "已停止。";
    }
  } finally {
    streaming = false;
    abortController = null;
    conversation.updatedAt = Date.now();
    saveState();
    render();
  }
}

async function readStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content ?? "";
        if (delta) onDelta(delta);
      } catch {
        // Ignore keep-alive lines that are not JSON.
      }
    }
  }
}

function deleteConversation(id) {
  if (streaming) return;
  state.conversations = state.conversations.filter((item) => item.id !== id);
  if (state.activeId === id) state.activeId = state.conversations[0]?.id ?? null;
  saveState();
  if (!activeConversation()) createConversation();
  render();
}

function openSidebar() {
  sidebar.classList.add("sidebar-open");
  backdrop.classList.add("visible");
}

function closeSidebar() {
  sidebar.classList.remove("sidebar-open");
  backdrop.classList.remove("visible");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const response = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: passwordInput.value }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    loginError.textContent = payload.error || "无法登录";
    return;
  }
  passwordInput.value = "";
  showApp({ fresh: true });
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (streaming) {
    abortController?.abort();
    return;
  }
  sendMessage(messageInput.value);
});

messageInput.addEventListener("focus", holdViewportStill);
messageInput.addEventListener("blur", () => window.setTimeout(fitVisibleViewport, 80));
passwordInput.addEventListener("focus", holdViewportStill);
messageInput.addEventListener("input", () => {
  resizeInput();
  updateSendButton();
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

document.querySelector("#new-chat").addEventListener("click", () => {
  if (streaming) abortController?.abort();
  createConversation();
  closeSidebar();
  chatError.textContent = "";
  render();
  messageInput.focus();
});
document.querySelector("#logout").addEventListener("click", async () => {
  if (streaming) abortController?.abort();
  await request("/api/logout", { method: "POST" });
  showGate();
});
document.querySelector("#menu-button").addEventListener("click", openSidebar);
document.querySelector("#sidebar-close").addEventListener("click", closeSidebar);
backdrop.addEventListener("click", closeSidebar);
document.querySelector("#search-button").addEventListener("click", () => {
  searching = !searching;
  if (window.innerWidth <= 760) openSidebar();
  render();
  if (searching) historyQuery.focus();
});
historySearch.addEventListener("submit", (event) => event.preventDefault());
historyQuery.addEventListener("input", render);

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (app.hidden) return;
    if (streaming) abortController?.abort();
    createConversation();
    closeSidebar();
    render();
    messageInput.focus();
  }
});

mountIcons();

async function boot() {
  try {
    const session = await request("/api/session");
    if (session.ok) showApp();
    else showGate();
  } catch {
    loginError.textContent = "无法连接服务";
    showGate();
  }
  updateSendButton();
}

boot();
