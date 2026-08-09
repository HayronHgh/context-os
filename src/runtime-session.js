import { randomUUID } from "node:crypto";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EVENT_HISTORY = 256;
const MAX_EVENT_HISTORY_BYTES = 2 * 1024 * 1024;

export class RuntimeSession {
  constructor({
    id = randomUUID(),
    projectRoot,
    runtimeFactory,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    now = () => new Date()
  }) {
    if (typeof runtimeFactory !== "function") throw new Error("runtimeFactory must be a function");
    if (!Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs < 1) {
      throw new Error("approvalTimeoutMs must be a positive integer");
    }
    this.id = id;
    this.projectRoot = projectRoot;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.now = now;
    this.createdAt = now().toISOString();
    this.busy = false;
    this.closed = false;
    this.sequence = 0;
    this.history = [];
    this.historyBytes = 0;
    this.listeners = new Set();
    this.approvals = new Map();
    this.runtime = runtimeFactory({
      projectRoot,
      confirm: (description) => this.requestApproval(description),
      onEvent: (event) => this.handleRuntimeEvent(event)
    });
    if (!this.runtime || typeof this.runtime.runTurn !== "function") {
      throw new Error("runtimeFactory must return an AgentRuntime-compatible object");
    }
    this.publish("session_ready", { sessionId: this.id, projectRoot: this.projectRoot });
  }

  snapshot() {
    return {
      id: this.id,
      projectRoot: this.projectRoot,
      createdAt: this.createdAt,
      busy: this.busy,
      pendingApprovals: this.approvals.size
    };
  }

  handleRuntimeEvent(event = {}) {
    const { type = "runtime", ...data } = event;
    this.publish(type, data);
  }

  publish(type, data = {}) {
    const record = Object.freeze({
      id: ++this.sequence,
      type: String(type).replace(/[^a-zA-Z0-9_-]/g, "_") || "runtime",
      timestamp: this.now().toISOString(),
      data
    });
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    this.history.push(record);
    this.historyBytes += recordBytes;
    while (this.history.length > 1 && (this.history.length > MAX_EVENT_HISTORY || this.historyBytes > MAX_EVENT_HISTORY_BYTES)) {
      const removed = this.history.shift();
      this.historyBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // A disconnected browser must not interrupt the runtime turn.
      }
    }
    return record;
  }

  subscribe(listener, { afterEventId = 0 } = {}) {
    if (typeof listener !== "function") throw new Error("listener must be a function");
    for (const record of this.history) {
      if (record.id > afterEventId) listener(record);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async runTurn(content) {
    if (this.closed) throw Object.assign(new Error("Runtime session is closed"), { code: "SESSION_CLOSED" });
    if (this.busy) throw Object.assign(new Error("A turn is already running"), { code: "SESSION_BUSY" });
    this.busy = true;
    this.publish("turn_start", { chars: content.length, content });
    try {
      const result = await this.runtime.runTurn(content);
      this.publish("turn_complete", { usage: result?.usage ?? null });
      return result;
    } catch (error) {
      this.publish("turn_error", { message: error.message });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  requestApproval(description) {
    if (this.closed) return Promise.resolve(false);
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(approvalId, false, "timeout"), this.approvalTimeoutMs);
      timer.unref?.();
      this.approvals.set(approvalId, { resolve, timer, description: String(description) });
      this.publish("approval_required", { approvalId, description: String(description) });
    });
  }

  resolveApproval(approvalId, approved, source = "browser") {
    const pending = this.approvals.get(approvalId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.approvals.delete(approvalId);
    const decision = approved === true;
    this.publish("approval_resolved", { approvalId, approved: decision, source });
    pending.resolve(decision);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const approvalId of [...this.approvals.keys()]) this.resolveApproval(approvalId, false, "session_closed");
    this.publish("session_closed", { sessionId: this.id });
    this.listeners.clear();
  }
}
