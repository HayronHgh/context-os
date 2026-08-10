import crypto from "node:crypto";
import { ContextManager } from "./context-manager.js";
import { serializeContext } from "./context-messages.js";

const ALLOWED_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const BRIDGE_ANCHOR = "ContextOS manages bounded continuation state for this local conversation.";

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  if (messages.length > 10000) throw new Error("messages exceeds the 10000 item limit");
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`messages[${index}] must be an object`);
    }
    if (!ALLOWED_ROLES.has(message.role)) throw new Error(`messages[${index}].role is unsupported`);
    const assistantToolCallOnly = message.role === "assistant"
      && message.content === undefined
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0;
    if (message.content === undefined && !assistantToolCallOnly) {
      throw new Error(`messages[${index}].content is required unless an assistant message contains tool_calls`);
    }
    if (!assistantToolCallOnly && message.content !== null && typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw new Error(`messages[${index}].content must be a string, array, or null`);
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      throw new Error(`messages[${index}].tool_calls must be an array`);
    }
  }
}

function boundedConversationId(value) {
  if (value === undefined || value === null || value === "") return "anonymous";
  if (typeof value !== "string" || value.length > 256) throw new Error("conversationId must be a string of at most 256 characters");
  return value;
}

function systemContent(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

// Qwen's llama.cpp chat template accepts a system message only at index 0.
// ContextManager deliberately emits state transfer as a separate system
// message, so the host compatibility boundary coalesces system instructions
// without changing the generic Runtime protocol.
function normalizeHostSystemPrefix(messages) {
  const systems = messages.filter((message) => message.role === "system");
  if (systems.length <= 1 && systems[0] === messages[0]) return messages;
  if (!systems.length) return messages;
  const [first] = systems;
  return [
    {
      ...first,
      content: systems.map((message) => systemContent(message.content)).join("\n\n")
    },
    ...messages.filter((message) => message.role !== "system")
  ];
}

export class HostContextBridge {
  constructor({ agentConfig, compactor, managerFactory, cacheEntries = 32, maximumCacheBytes = 33554432 } = {}) {
    if (!agentConfig || typeof agentConfig !== "object") throw new Error("HostContextBridge requires agentConfig");
    if (!compactor?.compact) throw new Error("HostContextBridge requires a state-transfer compactor");
    this.agentConfig = structuredClone(agentConfig);
    this.compactor = compactor;
    this.managerFactory = managerFactory ?? ((config) => new ContextManager(config));
    this.cacheEntries = Math.max(0, cacheEntries);
    this.maximumCacheBytes = Math.max(0, maximumCacheBytes);
    this.cacheBytes = 0;
    this.cache = new Map();
  }

  managerFor(maxOutputTokens) {
    const configuredReserve = this.agentConfig.reservedOutputTokens;
    const requestedReserve = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : configuredReserve;
    const reservedOutputTokens = Math.max(configuredReserve, requestedReserve);
    if (reservedOutputTokens >= this.agentConfig.contextWindow) {
      throw new Error("maxOutputTokens must be smaller than the configured contextWindow");
    }
    return this.managerFactory({ ...this.agentConfig, reservedOutputTokens });
  }

  remember(key, value) {
    if (!this.cacheEntries || !this.maximumCacheBytes) return;
    const cloned = structuredClone(value);
    const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
    if (bytes > this.maximumCacheBytes) return;
    const existing = this.cache.get(key);
    if (existing) this.cacheBytes -= existing.bytes;
    this.cache.delete(key);
    this.cache.set(key, { value: cloned, bytes });
    this.cacheBytes += bytes;
    while (this.cache.size > this.cacheEntries || this.cacheBytes > this.maximumCacheBytes) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.cacheBytes -= oldest.bytes;
    }
  }

  async prepare(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("request body must be one object");
    if (payload.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
    validateMessages(payload.messages);
    if (payload.tools !== undefined && !Array.isArray(payload.tools)) throw new Error("tools must be an array");
    const conversationId = boundedConversationId(payload.conversationId);
    const tools = structuredClone(payload.tools ?? []);
    const originalMessages = serializeContext(payload.messages);
    const sourceDigest = digest({ conversationId, messages: originalMessages, tools, maxOutputTokens: payload.maxOutputTokens ?? null });
    const cached = this.cache.get(sourceDigest);
    if (cached) return { ...structuredClone(cached.value), cacheHit: true };

    const manager = this.managerFor(payload.maxOutputTokens);
    const needsSemanticAnchor = manager.ratio(originalMessages, tools) >= manager.thresholds.semanticCompact
      && !["system", "developer"].includes(originalMessages[0]?.role);
    const workingMessages = needsSemanticAnchor
      ? [{ role: "system", content: BRIDGE_ANCHOR }, ...originalMessages]
      : originalMessages;
    const prepared = await manager.prepare(
      workingMessages,
      (older) => this.compactor.compact(older),
      { tools }
    );
    if (prepared.report.failure) {
      throw new Error(`prepared context remains above the failure threshold (${prepared.report.finalRatio.toFixed(3)})`);
    }
    const hostMessages = normalizeHostSystemPrefix(prepared.messages);
    const result = {
      schemaVersion: 1,
      status: prepared.report.actions.length ? "PREPARED" : "UNCHANGED",
      conversationId,
      sourceDigest,
      preparedDigest: digest(hostMessages),
      messages: serializeContext(hostMessages),
      report: {
        ...prepared.report,
        zeroHostMutation: true,
        browserHistoryPreserved: true
      },
      cacheHit: false
    };
    this.remember(sourceDigest, result);
    return result;
  }
}

export function hostContextBridgeHealth({ agentConfig, cacheEntries = 0 } = {}) {
  return {
    status: "ok",
    service: "context-os-host-bridge",
    schemaVersion: 1,
    contextWindow: agentConfig.contextWindow,
    reservedOutputTokens: agentConfig.reservedOutputTokens,
    thresholds: agentConfig.thresholds,
    cachedRequests: cacheEntries
  };
}
