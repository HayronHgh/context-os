const elements = Object.fromEntries([
  "runtimeStatus", "runtimeStatusText", "sessionSetup", "sessionForm", "projectRoot", "connectButton",
  "sessionError", "conversation", "projectName", "endSessionButton", "messages", "emptyState", "turnForm",
  "turnInput", "sendButton", "turnHint", "streamState", "activityFeed", "activityPlaceholder", "approvalCard",
  "approvalDescription", "approveButton", "denyButton"
].map((id) => [id, document.getElementById(id)]));

const state = { sessionId: null, events: null, busy: false, approvalId: null };

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers ?? {}) } : options.headers
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? body?.error ?? `Request failed (${response.status})`);
  return body;
}

function setRuntimeState(kind, text) {
  elements.runtimeStatus.dataset.state = kind;
  elements.runtimeStatusText.textContent = text;
}

function setBusy(busy, text = busy ? "Thinking…" : "Enter to send · Shift+Enter for newline") {
  state.busy = busy;
  elements.sendButton.disabled = busy;
  elements.turnInput.disabled = busy;
  elements.turnHint.textContent = text;
}

function hideEmptyState() {
  if (elements.emptyState) elements.emptyState.hidden = true;
}

function addMessage(role, content) {
  hideEmptyState();
  const article = document.createElement("article");
  article.className = `message message-${role}`;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "You" : role === "error" ? "Runtime error" : "Qwen · via ContextOS";
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = content;
  article.append(meta, body);
  elements.messages.append(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function addActivity(title, detail, kind = "neutral", timestamp = new Date().toISOString()) {
  elements.activityPlaceholder.hidden = true;
  const item = document.createElement("article");
  item.className = "activity-item";
  item.dataset.kind = kind;
  const heading = document.createElement("strong");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = detail;
  const time = document.createElement("time");
  time.dateTime = timestamp;
  time.textContent = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.append(heading, body, time);
  elements.activityFeed.append(item);
  elements.activityFeed.scrollTop = elements.activityFeed.scrollHeight;
}

function contextSummary(event) {
  const actions = Array.isArray(event.actions) && event.actions.length ? event.actions.join(", ") : "Context evaluated";
  if (Number.isFinite(event.initialRatio) && Number.isFinite(event.finalRatio)) {
    return `${actions} · ${(event.initialRatio * 100).toFixed(1)}% → ${(event.finalRatio * 100).toFixed(1)}%`;
  }
  return actions;
}

function showApproval(event) {
  state.approvalId = event.approvalId;
  elements.approvalDescription.textContent = event.description;
  elements.approvalCard.hidden = false;
  elements.approveButton.disabled = false;
  elements.denyButton.disabled = false;
}

function hideApproval() {
  state.approvalId = null;
  elements.approvalCard.hidden = true;
}

function listen(type, handler) {
  state.events.addEventListener(type, (event) => {
    const payload = JSON.parse(event.data);
    handler(payload);
  });
}

function connectEventStream(sessionId) {
  state.events?.close();
  state.events = new EventSource(`/api/sessions/${sessionId}/events`);
  elements.streamState.textContent = "Connecting";
  state.events.onopen = () => { elements.streamState.textContent = "Live"; };
  state.events.onerror = () => { elements.streamState.textContent = "Reconnecting"; };
  listen("session_ready", (event) => addActivity("Session ready", event.projectRoot, "success", event.timestamp));
  listen("turn_start", (event) => {
    if (event.content) addMessage("user", event.content);
    setBusy(true);
    addActivity("Thinking", `Processing ${event.chars} characters through the Runtime`, "neutral", event.timestamp);
  });
  listen("assistant", (event) => addMessage("assistant", event.content));
  listen("tool_start", (event) => addActivity("Tool requested", event.name, "attention", event.timestamp));
  listen("tool_end", (event) => {
    const evidence = event.evidence?.durable
      ? `Durable artifact · ${event.evidence.artifactId}`
      : event.evidence?.recoveryType === "context-only"
        ? "Context evidence · result retained by Runtime"
        : "Result returned to Runtime";
    const result = event.denied ? "Denied" : event.ok ? evidence : "Failed";
    addActivity(event.name, result, event.ok ? "success" : event.denied ? "attention" : "error", event.timestamp);
  });
  listen("context", (event) => addActivity("Context managed", contextSummary(event), "success", event.timestamp));
  listen("approval_required", (event) => {
    showApproval(event);
    addActivity("Approval required", event.description, "attention", event.timestamp);
  });
  listen("approval_resolved", (event) => {
    if (state.approvalId === event.approvalId) hideApproval();
    addActivity(event.approved ? "Approved" : "Denied", `Decision source: ${event.source}`, event.approved ? "success" : "attention", event.timestamp);
  });
  listen("turn_complete", (event) => {
    setBusy(false);
    const usage = event.usage?.total_tokens ? `${event.usage.total_tokens.toLocaleString()} total tokens` : "Turn complete";
    addActivity("Turn complete", usage, "success", event.timestamp);
    elements.turnInput.focus();
  });
  listen("turn_error", (event) => {
    setBusy(false, "Turn failed · try again");
    addMessage("error", event.message);
    addActivity("Turn failed", event.message, "error", event.timestamp);
  });
  listen("session_closed", () => { elements.streamState.textContent = "Closed"; });
}

async function createSession(projectRoot) {
  elements.connectButton.disabled = true;
  elements.sessionError.textContent = "";
  try {
    const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectRoot }) });
    state.sessionId = result.session.id;
    localStorage.setItem("context-os-session-id", state.sessionId);
    elements.projectName.textContent = result.session.projectRoot.split(/[\\/]/).filter(Boolean).pop() || result.session.projectRoot;
    elements.sessionSetup.hidden = true;
    elements.conversation.hidden = false;
    connectEventStream(state.sessionId);
    elements.turnInput.focus();
  } catch (error) {
    elements.sessionError.textContent = error.message;
  } finally {
    elements.connectButton.disabled = false;
  }
}

async function endSession() {
  if (!state.sessionId) return;
  if (state.busy && !window.confirm("A model turn is still running. End this browser session anyway?")) return;
  await api(`/api/sessions/${state.sessionId}`, { method: "DELETE" }).catch(() => null);
  state.events?.close();
  state.events = null;
  state.sessionId = null;
  localStorage.removeItem("context-os-session-id");
  state.busy = false;
  hideApproval();
  elements.messages.querySelectorAll(".message").forEach((node) => node.remove());
  elements.emptyState.hidden = false;
  elements.activityFeed.querySelectorAll(".activity-item").forEach((node) => node.remove());
  elements.activityPlaceholder.hidden = false;
  elements.streamState.textContent = "Offline";
  elements.conversation.hidden = true;
  elements.sessionSetup.hidden = false;
}

async function sendTurn(content) {
  if (!state.sessionId || state.busy) return;
  setBusy(true);
  try {
    await api(`/api/sessions/${state.sessionId}/turn`, { method: "POST", body: JSON.stringify({ content }) });
  } catch (error) {
    if (state.busy) {
      setBusy(false, "Turn failed · try again");
      addMessage("error", error.message);
    }
  }
}

async function answerApproval(approved) {
  if (!state.sessionId || !state.approvalId) return;
  const approvalId = state.approvalId;
  elements.approveButton.disabled = true;
  elements.denyButton.disabled = true;
  try {
    await api(`/api/sessions/${state.sessionId}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ approved })
    });
  } catch (error) {
    addActivity("Approval failed", error.message, "error");
    hideApproval();
  }
}

elements.sessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createSession(elements.projectRoot.value.trim());
});
elements.turnForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = elements.turnInput.value.trim();
  if (!content) return;
  elements.turnInput.value = "";
  elements.turnInput.style.height = "auto";
  sendTurn(content);
});
elements.turnInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.turnForm.requestSubmit();
  }
});
elements.turnInput.addEventListener("input", () => {
  elements.turnInput.style.height = "auto";
  elements.turnInput.style.height = `${Math.min(elements.turnInput.scrollHeight, 190)}px`;
});
elements.approveButton.addEventListener("click", () => answerApproval(true));
elements.denyButton.addEventListener("click", () => answerApproval(false));
elements.endSessionButton.addEventListener("click", endSession);
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  elements.turnInput.value = button.dataset.prompt;
  elements.turnInput.focus();
}));

async function restoreSession() {
  const sessionId = localStorage.getItem("context-os-session-id");
  if (!sessionId) return false;
  try {
    const result = await api(`/api/sessions/${sessionId}`);
    state.sessionId = sessionId;
    elements.projectName.textContent = result.session.projectRoot.split(/[\\/]/).filter(Boolean).pop() || result.session.projectRoot;
    elements.sessionSetup.hidden = true;
    elements.conversation.hidden = false;
    setBusy(result.session.busy);
    connectEventStream(sessionId);
    return true;
  } catch {
    localStorage.removeItem("context-os-session-id");
    return false;
  }
}

async function initialize() {
  try {
    const config = await api("/api/config");
    elements.projectRoot.value = config.defaultProjectRoot;
    await restoreSession();
  } catch (error) {
    elements.sessionError.textContent = error.message;
  }
  try {
    const health = await api("/api/health");
    setRuntimeState("ready", `llama.cpp · ${health.models?.[0] ?? "ready"}`);
  } catch (error) {
    setRuntimeState("offline", "llama.cpp offline");
    elements.sessionError.textContent = error.message;
  }
}

initialize();
