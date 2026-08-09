import {
  CONTEXT_UNIT_KINDS,
  ContextUnitIdFactory,
  createContextUnit
} from "./context-unit.js";
import { serializeMessageForModel } from "./context-messages.js";
import { estimateTokens, truncateMiddle } from "./utils.js";

function messageContent(message) {
  const wire = serializeMessageForModel(message);
  if (Object.keys(wire).length === 2 && typeof wire.content === "string") return wire.content;
  return JSON.stringify(wire);
}

function defaultDescriptor(message, isLatestUser) {
  if (message.role === "user") {
    return {
      kind: "USER_CONTEXT",
      authority: "USER",
      recoverability: "none",
      protectedReasons: isLatestUser ? ["LATEST_USER_TURN"] : []
    };
  }
  if (message.role === "assistant") {
    const references = message.context_os?.recoveryReferences;
    if (message.context_os?.kind === "externalized-tool-exchange" && Array.isArray(references) && references.length) {
      return {
        kind: "MEMORY_REFERENCE",
        authority: "DERIVED",
        recoverability: "artifact",
        recoveryRef: {
          artifactId: references[0].artifactId,
          artifactIds: references.map((reference) => reference.artifactId)
        },
        protectedReasons: []
      };
    }
    return {
      kind: "REASONING",
      authority: "SPECULATIVE",
      recoverability: "none",
      protectedReasons: []
    };
  }
  if (message.role === "tool") {
    const metadata = message.context_os ?? {};
    const durable = metadata.durable === true && metadata.recoveryType === "artifact" && metadata.artifactId;
    const failed = metadata.resultStatus === "error";
    return {
      kind: failed ? "ERROR" : metadata.unitKind === "FILE_SNAPSHOT" ? "FILE_SNAPSHOT" : "TOOL_EVIDENCE",
      authority: "EVIDENCE",
      recoverability: durable ? "artifact" : "none",
      recoveryRef: durable ? { artifactId: metadata.artifactId, sha256: metadata.sha256 ?? null } : null,
      protectedReasons: failed
        ? ["UNRESOLVED_ERROR"]
        : durable ? [] : ["NON_RECOVERABLE_EVIDENCE"]
    };
  }
  if (message.role === "system" && /^CODING STATE TRANSFER\b/.test(String(message.content ?? ""))) {
    return {
      kind: "STATE_TRANSFER",
      authority: "DERIVED",
      recoverability: "memory",
      protectedReasons: []
    };
  }
  return null;
}

function sessionPrefix(value) {
  const normalized = String(value ?? "session")
    .replace(/^session-/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64);
  return normalized || "session";
}

export class ContextInventory {
  constructor({ sessionId = "session", now = () => new Date() } = {}) {
    this.now = now;
    this.idFactory = new ContextUnitIdFactory(sessionPrefix(sessionId));
    this.units = new Map();
  }

  register(input) {
    const unit = createContextUnit(input, { idFactory: this.idFactory, now: this.now });
    if (this.units.has(unit.id)) throw new Error(`Duplicate Context Unit ID: ${unit.id}`);
    this.units.set(unit.id, unit);
    return structuredClone(unit);
  }

  registerMessage(message, { isLatestUser = false, taskId = null } = {}) {
    const runtimeDescriptor = defaultDescriptor(message, isLatestUser);
    if (!runtimeDescriptor) return null;
    const metadata = message.context_os && typeof message.context_os === "object"
      ? message.context_os
      : {};
    const customDescriptor = metadata.contextUnit && typeof metadata.contextUnit === "object"
      ? metadata.contextUnit
      : {};
    const descriptor = {
      ...runtimeDescriptor,
      ...customDescriptor,
      protectedReasons: [...new Set([
        ...(runtimeDescriptor.protectedReasons ?? []),
        ...(customDescriptor.protectedReasons ?? [])
      ])]
    };
    if (!CONTEXT_UNIT_KINDS.includes(descriptor.kind)) throw new Error(`Invalid message Context Unit kind: ${descriptor.kind}`);

    const existingId = metadata.contextUnitId;
    const existing = existingId ? this.units.get(existingId) : null;
    const createdAt = existing?.createdAt ?? metadata.contextUnitCreatedAt ?? this.now().toISOString();
    const runtimeReasons = new Set(descriptor.protectedReasons ?? []);
    if (message.role === "user") {
      if (isLatestUser) runtimeReasons.add("LATEST_USER_TURN");
      else runtimeReasons.delete("LATEST_USER_TURN");
    }
    const content = messageContent(message);
    const unit = createContextUnit({
      id: existingId,
      kind: descriptor.kind,
      content,
      source: descriptor.source ?? {
        type: "message",
        role: message.role,
        tool: message.name ?? null,
        toolCallId: message.tool_call_id ?? null
      },
      authority: descriptor.authority,
      createdAt,
      taskId: descriptor.taskId ?? taskId,
      recoverability: descriptor.recoverability,
      recoveryRef: descriptor.recoveryRef,
      protectedReasons: [...runtimeReasons],
      dependencies: descriptor.dependencies ?? [],
      tokenCost: estimateTokens(serializeMessageForModel(message)),
      lifecycle: "ACTIVE"
    }, { idFactory: this.idFactory, now: this.now });

    if (existingId && !existing) {
      const match = /_(\d+)$/.exec(existingId);
      if (match) this.idFactory.sequence = Math.max(this.idFactory.sequence, Number(match[1]));
    }
    this.units.set(unit.id, unit);
    message.context_os = {
      ...metadata,
      contextUnitId: unit.id,
      contextUnitCreatedAt: unit.createdAt
    };
    return structuredClone(unit);
  }

  synchronize(messages, { taskId = null } = {}) {
    for (const message of messages) {
      const match = /_(\d+)$/.exec(String(message?.context_os?.contextUnitId ?? ""));
      if (match) this.idFactory.sequence = Math.max(this.idFactory.sequence, Number(match[1]));
    }
    const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
    const active = new Set();
    messages.forEach((message, index) => {
      const unit = this.registerMessage(message, { isLatestUser: index === latestUserIndex, taskId });
      if (unit) {
        if (active.has(unit.id)) throw new Error(`Duplicate active Context Unit ID: ${unit.id}`);
        active.add(unit.id);
      }
    });

    for (const [id, unit] of this.units) {
      if (active.has(id)) continue;
      this.units.set(id, {
        ...unit,
        lifecycle: unit.recoverability === "none" ? "EVICTED" : "EXTERNALIZED"
      });
    }
    return this.snapshot();
  }

  get(unitId) {
    const value = this.units.get(unitId);
    return value ? structuredClone(value) : null;
  }

  validateDependencies() {
    const errors = [];
    for (const unit of this.units.values()) {
      for (const dependency of unit.dependencies) {
        if (!this.units.has(dependency.unitId)) {
          errors.push(`${unit.id} references missing Context Unit ${dependency.unitId}`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  snapshot({ pressure = null, task = null, includeInactive = false, includeContent = false } = {}) {
    const selected = [...this.units.values()].filter((unit) => includeInactive || unit.lifecycle === "ACTIVE");
    const units = selected.map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      tokens: unit.tokenCost,
      authority: unit.authority,
      recoverability: unit.recoverability,
      recoveryRef: structuredClone(unit.recoveryRef),
      protected: unit.protectedReasons.length > 0,
      protectedReasons: [...unit.protectedReasons],
      dependencies: structuredClone(unit.dependencies),
      lifecycle: unit.lifecycle,
      source: structuredClone(unit.source),
      summary: truncateMiddle(unit.content.replace(/\s+/g, " ").trim(), 240),
      ...(includeContent ? { content: unit.content } : {})
    }));
    return {
      pressure: pressure ? structuredClone(pressure) : null,
      task: task ? structuredClone(task) : null,
      stats: {
        totalUnits: units.length,
        totalTokens: units.reduce((total, unit) => total + unit.tokens, 0),
        protectedUnits: units.filter((unit) => unit.protected).length,
        recoverableUnits: units.filter((unit) => unit.recoverability !== "none").length,
        byKind: Object.fromEntries(CONTEXT_UNIT_KINDS.map((kind) => [kind, units.filter((unit) => unit.kind === kind).length]))
      },
      units
    };
  }
}
