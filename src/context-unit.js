import { estimateTokens } from "./utils.js";

export const CONTEXT_UNIT_KINDS = Object.freeze([
  "USER_REQUIREMENT",
  "USER_CONTEXT",
  "DECISION",
  "HYPOTHESIS",
  "ERROR",
  "TEST_RESULT",
  "TOOL_EVIDENCE",
  "FILE_SNAPSHOT",
  "REASONING",
  "PLAN",
  "STATE_TRANSFER",
  "MEMORY_REFERENCE"
]);

export const CONTEXT_UNIT_AUTHORITIES = Object.freeze([
  "USER",
  "SOURCE_OF_TRUTH",
  "EVIDENCE",
  "DERIVED",
  "SPECULATIVE"
]);

export const CONTEXT_UNIT_RECOVERABILITY = Object.freeze([
  "none",
  "artifact",
  "repository",
  "memory",
  "rebuildable"
]);

export const CONTEXT_UNIT_PROTECTED_REASONS = Object.freeze([
  "EXPLICIT_USER_CONSTRAINT",
  "LATEST_USER_TURN",
  "UNRESOLVED_ERROR",
  "UNRESOLVED_HYPOTHESIS",
  "ACTIVE_DECISION",
  "UNVERIFIED_MODIFICATION",
  "NON_RECOVERABLE_EVIDENCE",
  "DEPENDENCY_ROOT"
]);

export const CONTEXT_UNIT_DEPENDENCY_RELATIONS = Object.freeze([
  "supports",
  "contradicts",
  "depends_on",
  "supersedes"
]);

export const CONTEXT_UNIT_LIFECYCLES = Object.freeze([
  "ACTIVE",
  "RESOLVED",
  "SUPERSEDED",
  "EXTERNALIZED",
  "EVICTED"
]);

const UNIT_ID_PATTERN = /^cu_[A-Za-z0-9][A-Za-z0-9_-]{0,95}_\d{6,}$/;
const SESSION_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function requireEnum(name, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

function requireObject(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return structuredClone(value);
}

function uniqueEnums(name, values, allowed) {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
  return [...new Set(values.map((value) => requireEnum(name, value, allowed)))];
}

export function isContextUnitId(value) {
  return UNIT_ID_PATTERN.test(String(value ?? ""));
}

export class ContextUnitIdFactory {
  constructor(sessionPrefix, initialSequence = 0) {
    if (!SESSION_PREFIX_PATTERN.test(String(sessionPrefix ?? ""))) {
      throw new Error("Context Unit session prefix must be 1-64 letters, digits, underscores, or hyphens");
    }
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new Error("Context Unit initial sequence must be a non-negative safe integer");
    }
    this.sessionPrefix = sessionPrefix;
    this.sequence = initialSequence;
  }

  next() {
    this.sequence += 1;
    return `cu_${this.sessionPrefix}_${String(this.sequence).padStart(6, "0")}`;
  }
}

export function createContextUnit(input, { idFactory, now = () => new Date() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Context Unit input must be an object");
  const id = input.id ?? idFactory?.next();
  if (!isContextUnitId(id)) throw new Error(`Invalid Context Unit ID: ${id}`);
  if (typeof input.content !== "string") throw new Error("Context Unit content must be a string");

  const source = requireObject("Context Unit source", input.source);
  if (typeof source.type !== "string" || !source.type.trim()) throw new Error("Context Unit source.type must be a non-empty string");

  const createdAt = input.createdAt ?? now().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("Context Unit createdAt must be an ISO-8601 timestamp");
  }

  const recoverability = requireEnum(
    "Context Unit recoverability",
    input.recoverability ?? "none",
    CONTEXT_UNIT_RECOVERABILITY
  );
  const recoveryRef = input.recoveryRef == null ? null : requireObject("Context Unit recoveryRef", input.recoveryRef);
  if (recoverability === "artifact" && (typeof recoveryRef?.artifactId !== "string" || !recoveryRef.artifactId)) {
    throw new Error("Artifact-recoverable Context Unit requires recoveryRef.artifactId");
  }

  const dependencies = (input.dependencies ?? []).map((dependency) => {
    const value = requireObject("Context Unit dependency", dependency);
    if (!isContextUnitId(value.unitId)) throw new Error(`Invalid dependency Context Unit ID: ${value.unitId}`);
    if (value.unitId === id) throw new Error(`Context Unit ${id} cannot depend on itself`);
    requireEnum("Context Unit dependency relation", value.relation, CONTEXT_UNIT_DEPENDENCY_RELATIONS);
    return { unitId: value.unitId, relation: value.relation };
  });
  const dependencyKeys = dependencies.map(({ unitId, relation }) => `${unitId}:${relation}`);
  if (new Set(dependencyKeys).size !== dependencyKeys.length) throw new Error("Context Unit dependencies must be unique");

  const tokenCost = input.tokenCost ?? estimateTokens(input.content);
  if (!Number.isSafeInteger(tokenCost) || tokenCost < 0) throw new Error("Context Unit tokenCost must be a non-negative safe integer");
  if (input.taskId != null && typeof input.taskId !== "string") throw new Error("Context Unit taskId must be a string or null");

  return {
    id,
    kind: requireEnum("Context Unit kind", input.kind, CONTEXT_UNIT_KINDS),
    content: input.content,
    source,
    authority: requireEnum("Context Unit authority", input.authority, CONTEXT_UNIT_AUTHORITIES),
    createdAt,
    taskId: input.taskId ?? null,
    recoverability,
    recoveryRef,
    protectedReasons: uniqueEnums(
      "Context Unit protectedReasons",
      input.protectedReasons ?? [],
      CONTEXT_UNIT_PROTECTED_REASONS
    ),
    dependencies,
    tokenCost,
    lifecycle: requireEnum(
      "Context Unit lifecycle",
      input.lifecycle ?? "ACTIVE",
      CONTEXT_UNIT_LIFECYCLES
    )
  };
}
