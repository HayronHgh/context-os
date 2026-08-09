import { isContextUnitId } from "./context-unit.js";

export const COMPACTION_PLAN_SCHEMA_VERSION = 1;
export const COMPACTION_ACTIONS = Object.freeze([
  "KEEP",
  "COMPRESS",
  "EXTERNALIZE",
  "EVICT",
  "PROMOTE_PROPOSAL"
]);
export const COMPACTION_IMPORTANCE = Object.freeze([
  "critical",
  "high",
  "medium",
  "low"
]);

const PLAN_FIELDS = ["schemaVersion", "planId", "inventory", "decisions"];
const INVENTORY_FIELDS = ["id", "fingerprint"];
const DECISION_FIELDS = ["unitId", "action", "importance", "reason", "targetTokens"];
const PLAN_ID_PATTERN = /^plan_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const INVENTORY_ID_PATTERN = /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,95}_[a-f0-9]{16}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class CompactionPlanError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = "CompactionPlanError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = null) {
  throw new CompactionPlanError(code, message, path);
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SCHEMA_VIOLATION", `${path} must be an object`, path);
  }
  return value;
}

function requireExactFields(value, allowed, path) {
  const unexpected = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unexpected.length) {
    fail("SCHEMA_VIOLATION", `${path} has unexpected fields: ${unexpected.join(", ")}`, path);
  }
}

function requireString(value, path, { pattern = null, maximum = null } = {}) {
  if (typeof value !== "string" || !value.trim()) fail("SCHEMA_VIOLATION", `${path} must be a non-empty string`, path);
  if (maximum != null && value.length > maximum) fail("SCHEMA_VIOLATION", `${path} must be at most ${maximum} characters`, path);
  if (pattern && !pattern.test(value)) fail("SCHEMA_VIOLATION", `${path} has an invalid format`, path);
  return value;
}

function requireEnum(value, allowed, path) {
  if (!allowed.includes(value)) fail("SCHEMA_VIOLATION", `${path} must be one of: ${allowed.join(", ")}`, path);
  return value;
}

function validateDecision(input, index) {
  const path = `decisions[${index}]`;
  const value = requireObject(input, path);
  requireExactFields(value, DECISION_FIELDS, path);
  const required = ["unitId", "action", "importance", "reason"];
  const missing = required.filter((field) => value[field] === undefined);
  if (missing.length) fail("SCHEMA_VIOLATION", `${path} is missing fields: ${missing.join(", ")}`, path);
  if (!isContextUnitId(value.unitId)) fail("SCHEMA_VIOLATION", `${path}.unitId is invalid`, `${path}.unitId`);
  requireEnum(value.action, COMPACTION_ACTIONS, `${path}.action`);
  requireEnum(value.importance, COMPACTION_IMPORTANCE, `${path}.importance`);
  requireString(value.reason, `${path}.reason`, { maximum: 1000 });
  if (value.targetTokens !== undefined) {
    if (value.action !== "COMPRESS") {
      fail("SCHEMA_VIOLATION", `${path}.targetTokens is only valid for COMPRESS`, `${path}.targetTokens`);
    }
    if (!Number.isSafeInteger(value.targetTokens) || value.targetTokens <= 0) {
      fail("SCHEMA_VIOLATION", `${path}.targetTokens must be a positive safe integer`, `${path}.targetTokens`);
    }
  }
  return {
    unitId: value.unitId,
    action: value.action,
    importance: value.importance,
    reason: value.reason,
    ...(value.targetTokens === undefined ? {} : { targetTokens: value.targetTokens })
  };
}

export function parseCompactionPlan(input) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      fail("MALFORMED_JSON", `Compaction plan is not valid JSON: ${error.message}`);
    }
  }
  const value = requireObject(raw, "plan");
  requireExactFields(value, PLAN_FIELDS, "plan");
  const missing = PLAN_FIELDS.filter((field) => value[field] === undefined);
  if (missing.length) fail("SCHEMA_VIOLATION", `plan is missing fields: ${missing.join(", ")}`, "plan");
  if (value.schemaVersion !== COMPACTION_PLAN_SCHEMA_VERSION) {
    fail("SCHEMA_VIOLATION", `schemaVersion must be ${COMPACTION_PLAN_SCHEMA_VERSION}`, "schemaVersion");
  }
  requireString(value.planId, "planId", { pattern: PLAN_ID_PATTERN });

  const inventory = requireObject(value.inventory, "inventory");
  requireExactFields(inventory, INVENTORY_FIELDS, "inventory");
  const missingInventory = INVENTORY_FIELDS.filter((field) => inventory[field] === undefined);
  if (missingInventory.length) fail("SCHEMA_VIOLATION", `inventory is missing fields: ${missingInventory.join(", ")}`, "inventory");
  requireString(inventory.id, "inventory.id", { pattern: INVENTORY_ID_PATTERN });
  requireString(inventory.fingerprint, "inventory.fingerprint", { pattern: FINGERPRINT_PATTERN });

  if (!Array.isArray(value.decisions)) fail("SCHEMA_VIOLATION", "decisions must be an array", "decisions");
  const decisions = value.decisions.map(validateDecision);
  const unitIds = decisions.map((decision) => decision.unitId);
  if (new Set(unitIds).size !== unitIds.length) {
    fail("DUPLICATE_DECISION", "Compaction plan cannot contain multiple decisions for one Context Unit", "decisions");
  }

  return {
    schemaVersion: COMPACTION_PLAN_SCHEMA_VERSION,
    planId: value.planId,
    inventory: { id: inventory.id, fingerprint: inventory.fingerprint },
    decisions
  };
}

export function validatePlanBinding(input, inventorySnapshot) {
  const plan = parseCompactionPlan(input);
  const currentIdentity = inventorySnapshot?.inventory;
  if (!currentIdentity || typeof currentIdentity.id !== "string" || typeof currentIdentity.fingerprint !== "string") {
    fail("INVALID_INVENTORY", "Current inventory snapshot has no valid identity", "inventory");
  }
  if (plan.inventory.id !== currentIdentity.id || plan.inventory.fingerprint !== currentIdentity.fingerprint) {
    fail("STALE_INVENTORY", "Compaction plan is bound to a stale inventory snapshot", "inventory");
  }
  const knownUnits = new Set((inventorySnapshot.units ?? []).map((unit) => unit.id));
  const unknown = plan.decisions.filter((decision) => !knownUnits.has(decision.unitId)).map((decision) => decision.unitId);
  if (unknown.length) fail("UNKNOWN_UNIT", `Compaction plan references unknown units: ${unknown.join(", ")}`, "decisions");
  return plan;
}

export function expandPlanDefaults(input, inventorySnapshot) {
  const plan = validatePlanBinding(input, inventorySnapshot);
  const explicit = new Map(plan.decisions.map((decision) => [decision.unitId, decision]));
  return inventorySnapshot.units.map((unit) => {
    const decision = explicit.get(unit.id);
    if (decision) {
      return {
        unitId: unit.id,
        action: decision.action,
        importance: decision.importance,
        reason: decision.reason,
        ...(decision.targetTokens === undefined ? {} : { targetTokens: decision.targetTokens }),
        implicit: false
      };
    }
    return {
      unitId: unit.id,
      action: "KEEP",
      importance: null,
      reason: "UNMENTIONED_DEFAULT_KEEP",
      implicit: true
    };
  });
}
