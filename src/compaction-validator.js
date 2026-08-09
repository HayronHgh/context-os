import {
  CompactionPlanError,
  expandPlanDefaults
} from "./compaction-plan.js";
import {
  CONTEXT_UNIT_AUTHORITIES,
  CONTEXT_UNIT_RECOVERABILITY
} from "./context-unit.js";

export const VALIDATED_PLAN_SCHEMA_VERSION = 1;

export const VALIDATION_STATUSES = Object.freeze([
  "AUTHORIZED_DEFINITELY_INSUFFICIENT",
  "AUTHORIZED_POTENTIALLY_SUFFICIENT",
  "REJECTED"
]);

export const AUTHORIZATION_PERMISSIONS = Object.freeze([
  "AUTHORIZED",
  "REJECTED",
  "AUDIT_ONLY"
]);

export const PLAN_REASON_CODES = Object.freeze([
  "STALE_INVENTORY",
  "UNKNOWN_UNIT",
  "DUPLICATE_DECISION",
  "MISSING_DEPENDENCY",
  "DEPENDENCY_CYCLE",
  "FAILURE_ENVELOPE_RISK"
]);

export const DECISION_REASON_CODES = Object.freeze([
  "PROTECTED_UNIT",
  "AUTHORITY_VIOLATION",
  "NON_RECOVERABLE",
  "ACTIVE_DEPENDENCY",
  "UNSUPPORTED_PROMOTION",
  "INVALID_ACTION",
  "INVALID_COMPRESSION_TARGET"
]);

const ALLOW = "ALLOW";
const REQUIRE_RECOVERABLE = "REQUIRE_RECOVERABLE";
const REQUIRE_DURABLE = "REQUIRE_DURABLE";
const REQUIRE_REPOSITORY = "REQUIRE_REPOSITORY";
const DESTRUCTIVE_ACTIONS = new Set(["COMPRESS", "EXTERNALIZE", "EVICT"]);

function freezePolicy(policy) {
  return Object.freeze(Object.fromEntries(
    Object.entries(policy).map(([authority, actions]) => [authority, Object.freeze({ ...actions })])
  ));
}

export const AUTHORIZATION_POLICY = freezePolicy({
  USER: {
    KEEP: ALLOW,
    COMPRESS: ALLOW,
    EXTERNALIZE: REQUIRE_RECOVERABLE,
    EVICT: REQUIRE_RECOVERABLE
  },
  SOURCE_OF_TRUTH: {
    KEEP: ALLOW,
    COMPRESS: ALLOW,
    EXTERNALIZE: REQUIRE_REPOSITORY,
    EVICT: REQUIRE_RECOVERABLE
  },
  EVIDENCE: {
    KEEP: ALLOW,
    COMPRESS: REQUIRE_DURABLE,
    EXTERNALIZE: REQUIRE_RECOVERABLE,
    EVICT: REQUIRE_DURABLE
  },
  DERIVED: {
    KEEP: ALLOW,
    COMPRESS: ALLOW,
    EXTERNALIZE: REQUIRE_RECOVERABLE,
    EVICT: REQUIRE_RECOVERABLE
  },
  SPECULATIVE: {
    KEEP: ALLOW,
    COMPRESS: ALLOW,
    EXTERNALIZE: REQUIRE_RECOVERABLE,
    EVICT: REQUIRE_RECOVERABLE
  }
});

export const RECOVERABILITY_POLICY = Object.freeze({
  artifact: Object.freeze({ recoverable: true, durable: true }),
  repository: Object.freeze({ recoverable: true, durable: true }),
  memory: Object.freeze({ recoverable: true, durable: true }),
  rebuildable: Object.freeze({ recoverable: true, durable: false }),
  none: Object.freeze({ recoverable: false, durable: false })
});

export function isRecoverable(unit) {
  return RECOVERABILITY_POLICY[unit?.recoverability]?.recoverable === true;
}

export function isDurablyRecoverable(unit) {
  return RECOVERABILITY_POLICY[unit?.recoverability]?.durable === true;
}

export function postActionAvailability(unit, action) {
  if (action === "COMPRESS") return "ACTIVE_TRANSFORMED";
  if (action === "EXTERNALIZE") return isRecoverable(unit) ? "RECOVERABLE" : "UNAVAILABLE";
  if (action === "EVICT") return isRecoverable(unit) ? "RECOVERABLE" : "UNAVAILABLE";
  if (action === "KEEP" || action === "PROMOTE_PROPOSAL") {
    if (unit?.lifecycle === "EVICTED") return isRecoverable(unit) ? "RECOVERABLE" : "UNAVAILABLE";
    if (unit?.lifecycle === "EXTERNALIZED") return isRecoverable(unit) ? "RECOVERABLE" : "UNAVAILABLE";
    return "ACTIVE";
  }
  return "UNAVAILABLE";
}

export function buildDependsOnGraph(units) {
  const graph = new Map(units.map((unit) => [unit.id, new Set()]));
  const missing = [];
  for (const unit of units) {
    for (const dependency of unit.dependencies ?? []) {
      if (dependency.relation !== "depends_on") continue;
      if (!graph.has(dependency.unitId)) {
        missing.push({ unitId: unit.id, dependencyUnitId: dependency.unitId });
        continue;
      }
      graph.get(unit.id).add(dependency.unitId);
    }
  }
  return { graph, missing };
}

export function detectDependencyCycle(graph) {
  const visiting = new Set();
  const visited = new Set();

  function visit(unitId) {
    if (visiting.has(unitId)) return true;
    if (visited.has(unitId)) return false;
    visiting.add(unitId);
    for (const dependencyUnitId of graph.get(unitId) ?? []) {
      if (visit(dependencyUnitId)) return true;
    }
    visiting.delete(unitId);
    visited.add(unitId);
    return false;
  }

  for (const unitId of graph.keys()) {
    if (visit(unitId)) return true;
  }
  return false;
}

export function computeDependencyClosure(graph) {
  const closure = new Map();
  for (const root of graph.keys()) {
    const reachable = new Set();
    const pending = [...(graph.get(root) ?? [])];
    while (pending.length) {
      const unitId = pending.pop();
      if (reachable.has(unitId)) continue;
      reachable.add(unitId);
      pending.push(...(graph.get(unitId) ?? []));
    }
    closure.set(root, reachable);
  }
  return closure;
}

function requiredReductionTokens(pressure) {
  const value = pressure?.requiredReductionTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function protocolReason(error) {
  if (!(error instanceof CompactionPlanError)) return "FAILURE_ENVELOPE_RISK";
  if (["STALE_INVENTORY", "UNKNOWN_UNIT", "DUPLICATE_DECISION"].includes(error.code)) return error.code;
  return "FAILURE_ENVELOPE_RISK";
}

function planIdentity(plan, inventory) {
  if (plan && typeof plan === "object" && !Array.isArray(plan) && typeof plan.planId === "string") {
    return plan.planId;
  }
  return null;
}

function inventoryIdentity(inventory) {
  const identity = inventory?.inventory;
  if (!identity || typeof identity.id !== "string" || typeof identity.fingerprint !== "string") return null;
  return { id: identity.id, fingerprint: identity.fingerprint };
}

function rejectedResult({ plan, inventory, pressure, reasonCodes, decisions = [] }) {
  return {
    schemaVersion: VALIDATED_PLAN_SCHEMA_VERSION,
    planId: planIdentity(plan, inventory),
    inventory: inventoryIdentity(inventory),
    status: "REJECTED",
    reasonCodes: [...reasonCodes],
    decisions: structuredClone(decisions),
    runtime: {
      requiredReductionTokens: requiredReductionTokens(pressure),
      potentialReductionUpperBound: 0,
      actualReductionTokens: null,
      fallbackRequired: true
    }
  };
}

function validInventoryUnit(unit) {
  const tokens = unit?.tokens;
  return unit
    && typeof unit === "object"
    && typeof unit.id === "string"
    && Number.isSafeInteger(tokens)
    && tokens >= 0
    && CONTEXT_UNIT_AUTHORITIES.includes(unit.authority)
    && CONTEXT_UNIT_RECOVERABILITY.includes(unit.recoverability)
    && Array.isArray(unit.protectedReasons)
    && Array.isArray(unit.dependencies);
}

function baseDecision(decision) {
  return {
    unitId: decision.unitId,
    proposedAction: decision.action,
    permission: "REJECTED",
    reasonCodes: [],
    importance: decision.importance,
    requestedTargetTokens: decision.targetTokens ?? null,
    potentialReductionUpperBound: 0,
    replacementCostUnknown: ["EXTERNALIZE", "EVICT"].includes(decision.action)
  };
}

function rejectDecision(result, code) {
  result.permission = "REJECTED";
  if (!result.reasonCodes.includes(code)) result.reasonCodes.push(code);
  result.potentialReductionUpperBound = 0;
  return result;
}

function authorizeByPolicy(unit, decision, result) {
  if (decision.action === "PROMOTE_PROPOSAL") {
    result.permission = "AUDIT_ONLY";
    result.reasonCodes.push("UNSUPPORTED_PROMOTION");
    return result;
  }
  if (decision.action === "KEEP") {
    result.permission = "AUTHORIZED";
    return result;
  }
  if (!DESTRUCTIVE_ACTIONS.has(decision.action)) return rejectDecision(result, "INVALID_ACTION");
  if (unit.protected === true || unit.protectedReasons.length > 0) {
    return rejectDecision(result, "PROTECTED_UNIT");
  }

  const requirement = AUTHORIZATION_POLICY[unit.authority]?.[decision.action];
  if (!requirement) return rejectDecision(result, "AUTHORITY_VIOLATION");
  if (requirement === REQUIRE_REPOSITORY && unit.recoverability !== "repository") {
    return rejectDecision(result, "AUTHORITY_VIOLATION");
  }
  if (requirement === REQUIRE_DURABLE && !isDurablyRecoverable(unit)) {
    return rejectDecision(result, "NON_RECOVERABLE");
  }
  if (requirement === REQUIRE_RECOVERABLE && !isRecoverable(unit)) {
    return rejectDecision(result, "NON_RECOVERABLE");
  }

  if (decision.action === "COMPRESS") {
    if (!Number.isSafeInteger(decision.targetTokens) || decision.targetTokens >= unit.tokens) {
      return rejectDecision(result, "INVALID_COMPRESSION_TARGET");
    }
    result.potentialReductionUpperBound = unit.tokens - decision.targetTokens;
  } else {
    result.potentialReductionUpperBound = unit.tokens;
  }
  result.permission = "AUTHORIZED";
  return result;
}

function failGraphPlan({ plan, inventory, pressure, expanded, reasonCode }) {
  const decisions = expanded.map((decision) => baseDecision(decision));
  return rejectedResult({ plan, inventory, pressure, reasonCodes: [reasonCode], decisions });
}

export function validateCompactionAuthorization({ plan, inventory, pressure } = {}) {
  const required = requiredReductionTokens(pressure);
  if (required == null) {
    return rejectedResult({
      plan,
      inventory,
      pressure,
      reasonCodes: ["FAILURE_ENVELOPE_RISK"]
    });
  }

  let expanded;
  try {
    expanded = expandPlanDefaults(plan, inventory);
  } catch (error) {
    return rejectedResult({
      plan,
      inventory,
      pressure,
      reasonCodes: [protocolReason(error)]
    });
  }

  const units = inventory?.units;
  const unitIds = Array.isArray(units) ? units.map((unit) => unit.id) : [];
  if (!Array.isArray(units)
    || units.some((unit) => !validInventoryUnit(unit))
    || new Set(unitIds).size !== unitIds.length) {
    return rejectedResult({
      plan,
      inventory,
      pressure,
      reasonCodes: ["FAILURE_ENVELOPE_RISK"]
    });
  }

  const { graph, missing } = buildDependsOnGraph(units);
  if (missing.length) {
    return failGraphPlan({ plan, inventory, pressure, expanded, reasonCode: "MISSING_DEPENDENCY" });
  }
  if (detectDependencyCycle(graph)) {
    return failGraphPlan({ plan, inventory, pressure, expanded, reasonCode: "DEPENDENCY_CYCLE" });
  }

  const closure = computeDependencyClosure(graph);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const expandedById = new Map(expanded.map((decision) => [decision.unitId, decision]));
  const decisions = expanded.map((decision) => {
    const unit = unitById.get(decision.unitId);
    return authorizeByPolicy(unit, decision, baseDecision(decision));
  });
  const resultById = new Map(decisions.map((decision) => [decision.unitId, decision]));

  for (const unit of units) {
    if (unit.lifecycle !== "ACTIVE") continue;
    const rootDecision = expandedById.get(unit.id);
    if (postActionAvailability(unit, rootDecision.action) === "UNAVAILABLE") continue;
    for (const dependencyUnitId of closure.get(unit.id) ?? []) {
      const dependencyUnit = unitById.get(dependencyUnitId);
      const dependencyDecision = expandedById.get(dependencyUnitId);
      if (postActionAvailability(dependencyUnit, dependencyDecision.action) === "UNAVAILABLE") {
        rejectDecision(resultById.get(dependencyUnitId), "ACTIVE_DEPENDENCY");
      }
    }
  }

  const rejected = decisions.some((decision) => decision.permission === "REJECTED");
  const potentialReductionUpperBound = decisions
    .filter((decision) => decision.permission === "AUTHORIZED")
    .reduce((total, decision) => total + decision.potentialReductionUpperBound, 0);
  const status = rejected
    ? "REJECTED"
    : potentialReductionUpperBound < required
      ? "AUTHORIZED_DEFINITELY_INSUFFICIENT"
      : "AUTHORIZED_POTENTIALLY_SUFFICIENT";

  return {
    schemaVersion: VALIDATED_PLAN_SCHEMA_VERSION,
    planId: plan.planId,
    inventory: inventoryIdentity(inventory),
    status,
    reasonCodes: [],
    decisions,
    runtime: {
      requiredReductionTokens: required,
      potentialReductionUpperBound,
      actualReductionTokens: null,
      fallbackRequired: status !== "AUTHORIZED_POTENTIALLY_SUFFICIENT"
    }
  };
}
