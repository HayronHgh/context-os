import {
  AUTHORIZATION_PERMISSIONS,
  VALIDATED_PLAN_SCHEMA_VERSION,
  VALIDATION_STATUSES
} from "./compaction-validator.js";
import { COMPACTION_ACTIONS, COMPACTION_IMPORTANCE } from "./compaction-plan.js";
import { CONTEXT_UNIT_RECOVERABILITY, isContextUnitId } from "./context-unit.js";
import { RecoveryVerifier } from "./recovery-verifier.js";

export const EXECUTABLE_PLAN_SCHEMA_VERSION = 1;
export const EXECUTION_PREFLIGHT_SCHEMA_VERSION = 1;

export const EXECUTION_PREFLIGHT_STATUSES = Object.freeze([
  "EXECUTABLE",
  "EXECUTION_PRECONDITION_FAILED"
]);

export const EXECUTION_PREFLIGHT_REASON_CODES = Object.freeze([
  "INVALID_VALIDATED_PLAN",
  "VALIDATED_PLAN_NOT_EXECUTABLE",
  "FALLBACK_REQUIRED",
  "INVALID_CURRENT_INVENTORY",
  "STALE_INVENTORY",
  "INVENTORY_DECISION_MISMATCH",
  "UNAUTHORIZED_DECISION",
  "RECOVERY_REFERENCE_MISSING",
  "RECOVERY_PROVIDER_UNAVAILABLE",
  "RECOVERY_SOURCE_NOT_FOUND",
  "RECOVERY_SOURCE_INVALID",
  "RECOVERY_INTEGRITY_MISMATCH",
  "RECOVERY_VERIFICATION_FAILED"
]);

const PLAN_FIELDS = ["schemaVersion", "planId", "inventory", "status", "reasonCodes", "decisions", "runtime"];
const IDENTITY_FIELDS = ["id", "fingerprint"];
const DECISION_FIELDS = [
  "unitId",
  "proposedAction",
  "permission",
  "reasonCodes",
  "importance",
  "requestedTargetTokens",
  "potentialReductionUpperBound",
  "replacementCostUnknown"
];
const RUNTIME_FIELDS = [
  "requiredReductionTokens",
  "potentialReductionUpperBound",
  "actualReductionTokens",
  "fallbackRequired"
];
const PLAN_ID_PATTERN = /^plan_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXECUTION_DISPOSITIONS = Object.freeze(["READY", "NOOP", "AUDIT_ONLY"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactFields(value, fields) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => fields.includes(field));
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validIdentity(value) {
  return exactFields(value, IDENTITY_FIELDS)
    && typeof value.id === "string"
    && /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,95}_[a-f0-9]{16}$/.test(value.id)
    && FINGERPRINT_PATTERN.test(value.fingerprint);
}

function validDecision(value) {
  const baseValid = exactFields(value, DECISION_FIELDS)
    && isContextUnitId(value.unitId)
    && COMPACTION_ACTIONS.includes(value.proposedAction)
    && AUTHORIZATION_PERMISSIONS.includes(value.permission)
    && stringArray(value.reasonCodes)
    && (value.importance === null || COMPACTION_IMPORTANCE.includes(value.importance))
    && (value.requestedTargetTokens === null
      || (Number.isSafeInteger(value.requestedTargetTokens) && value.requestedTargetTokens > 0))
    && nonNegativeInteger(value.potentialReductionUpperBound)
    && typeof value.replacementCostUnknown === "boolean";
  if (!baseValid) return false;
  if (value.requestedTargetTokens !== null && value.proposedAction !== "COMPRESS") return false;
  if (value.permission === "AUTHORIZED" && value.reasonCodes.length > 0) return false;
  if (value.permission !== "AUTHORIZED" && value.potentialReductionUpperBound !== 0) return false;
  if (value.permission === "AUDIT_ONLY" && value.proposedAction !== "PROMOTE_PROPOSAL") return false;
  if (value.permission === "AUTHORIZED" && value.proposedAction === "PROMOTE_PROPOSAL") return false;
  if (value.permission === "AUTHORIZED"
    && value.proposedAction === "COMPRESS"
    && value.requestedTargetTokens === null) return false;
  return value.replacementCostUnknown === ["EXTERNALIZE", "EVICT"].includes(value.proposedAction);
}

function validateShape(plan) {
  if (!exactFields(plan, PLAN_FIELDS)) return false;
  if (plan.schemaVersion !== VALIDATED_PLAN_SCHEMA_VERSION) return false;
  if (typeof plan.planId !== "string" || !PLAN_ID_PATTERN.test(plan.planId)) return false;
  if (!validIdentity(plan.inventory)) return false;
  if (!VALIDATION_STATUSES.includes(plan.status) || !stringArray(plan.reasonCodes)) return false;
  if (!Array.isArray(plan.decisions) || plan.decisions.some((decision) => !validDecision(decision))) return false;
  if (!exactFields(plan.runtime, RUNTIME_FIELDS)) return false;
  if (!nonNegativeInteger(plan.runtime.requiredReductionTokens)) return false;
  if (!nonNegativeInteger(plan.runtime.potentialReductionUpperBound)) return false;
  if (plan.runtime.actualReductionTokens !== null) return false;
  if (typeof plan.runtime.fallbackRequired !== "boolean") return false;
  if (plan.runtime.fallbackRequired !== (plan.status !== "AUTHORIZED_POTENTIALLY_SUFFICIENT")) return false;
  if (plan.status === "AUTHORIZED_POTENTIALLY_SUFFICIENT"
    && plan.runtime.potentialReductionUpperBound < plan.runtime.requiredReductionTokens) return false;
  if (plan.status === "AUTHORIZED_DEFINITELY_INSUFFICIENT"
    && plan.runtime.potentialReductionUpperBound >= plan.runtime.requiredReductionTokens) return false;
  const calculatedUpperBound = plan.decisions
    .filter((decision) => decision.permission === "AUTHORIZED")
    .reduce((total, decision) => total + decision.potentialReductionUpperBound, 0);
  if (calculatedUpperBound !== plan.runtime.potentialReductionUpperBound) return false;
  return new Set(plan.decisions.map((decision) => decision.unitId)).size === plan.decisions.length;
}

function identityOf(inventory) {
  return inventory?.inventory && typeof inventory.inventory === "object"
    ? { id: inventory.inventory.id, fingerprint: inventory.inventory.fingerprint }
    : null;
}

function validInventoryUnit(unit) {
  return unit
    && typeof unit === "object"
    && isContextUnitId(unit.id)
    && CONTEXT_UNIT_RECOVERABILITY.includes(unit.recoverability)
    && (unit.recoveryRef === null
      || (typeof unit.recoveryRef === "object" && !Array.isArray(unit.recoveryRef)))
    && nonNegativeInteger(unit.tokens);
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function failedResult({ plan, inventory, checkedAt, reasons, checks = [] }) {
  return deepFreeze({
    schemaVersion: EXECUTION_PREFLIGHT_SCHEMA_VERSION,
    status: "EXECUTION_PRECONDITION_FAILED",
    planId: typeof plan?.planId === "string" ? plan.planId : null,
    inventory: identityOf(inventory),
    reasonCodes: [...reasons],
    checks: structuredClone(checks),
    executablePlan: null,
    runtime: {
      checkedAt,
      zeroMutation: true
    }
  });
}

function disposition(decision) {
  if (decision.permission === "AUDIT_ONLY") return "AUDIT_ONLY";
  if (decision.proposedAction === "KEEP") return "NOOP";
  return "READY";
}

function executablePlanId(planId) {
  return `exec_${planId.slice("plan_".length)}`;
}

export async function preflightValidatedPlan({
  validatedPlan,
  inventory,
  recoveryVerifier,
  now = () => new Date()
} = {}) {
  const checkedAt = now().toISOString();
  const reasons = [];
  if (!(recoveryVerifier instanceof RecoveryVerifier)) {
    throw new Error("ExecutionPreflight requires a RecoveryVerifier");
  }
  if (!validateShape(validatedPlan)) {
    return failedResult({
      plan: validatedPlan,
      inventory,
      checkedAt,
      reasons: ["INVALID_VALIDATED_PLAN"]
    });
  }

  const currentIdentity = identityOf(inventory);
  if (!validIdentity(currentIdentity)) {
    addReason(reasons, "INVALID_CURRENT_INVENTORY");
  } else if (currentIdentity.id !== validatedPlan.inventory.id
    || currentIdentity.fingerprint !== validatedPlan.inventory.fingerprint) {
    addReason(reasons, "STALE_INVENTORY");
  }
  if (validatedPlan.status !== "AUTHORIZED_POTENTIALLY_SUFFICIENT") {
    addReason(reasons, "VALIDATED_PLAN_NOT_EXECUTABLE");
  }
  if (validatedPlan.runtime.fallbackRequired) addReason(reasons, "FALLBACK_REQUIRED");
  if (validatedPlan.decisions.some((decision) => decision.permission === "REJECTED")) {
    addReason(reasons, "UNAUTHORIZED_DECISION");
  }

  const units = Array.isArray(inventory?.units) ? inventory.units : [];
  const unitIds = units.map((unit) => unit.id);
  const decisionIds = validatedPlan.decisions.map((decision) => decision.unitId);
  if (!Array.isArray(inventory?.units)
    || units.some((unit) => !validInventoryUnit(unit))) {
    addReason(reasons, "INVALID_CURRENT_INVENTORY");
  }
  if (units.length !== validatedPlan.decisions.length
    || new Set(unitIds).size !== unitIds.length
    || unitIds.some((unitId) => !decisionIds.includes(unitId))) {
    addReason(reasons, "INVENTORY_DECISION_MISMATCH");
  }
  if (reasons.length) {
    return failedResult({ plan: validatedPlan, inventory, checkedAt, reasons });
  }

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const checks = [];
  for (const decision of validatedPlan.decisions) {
    if (decision.permission === "AUDIT_ONLY" && decision.proposedAction !== "PROMOTE_PROPOSAL") {
      addReason(reasons, "UNAUTHORIZED_DECISION");
      continue;
    }
    if (decision.permission === "AUTHORIZED" && decision.proposedAction === "PROMOTE_PROPOSAL") {
      addReason(reasons, "UNAUTHORIZED_DECISION");
      continue;
    }
    const proof = await recoveryVerifier.verify({
      unit: unitById.get(decision.unitId),
      action: decision.proposedAction
    });
    checks.push({
      unitId: decision.unitId,
      action: decision.proposedAction,
      permission: decision.permission,
      recoveryProof: proof
    });
    if (proof.status === "FAILED") addReason(reasons, proof.code);
  }
  if (reasons.length) {
    return failedResult({ plan: validatedPlan, inventory, checkedAt, reasons, checks });
  }

  const decisionById = new Map(validatedPlan.decisions.map((decision) => [decision.unitId, decision]));
  const proofById = new Map(checks.map((check) => [check.unitId, check.recoveryProof]));
  const decisions = units.map((unit) => {
    const decision = decisionById.get(unit.id);
    const executionDisposition = disposition(decision);
    if (!EXECUTION_DISPOSITIONS.includes(executionDisposition)) throw new Error("Invalid execution disposition");
    return {
      unitId: unit.id,
      action: decision.proposedAction,
      executionDisposition,
      importance: decision.importance,
      requestedTargetTokens: decision.requestedTargetTokens,
      potentialReductionUpperBound: decision.potentialReductionUpperBound,
      recoveryProof: proofById.get(unit.id)
    };
  });

  return deepFreeze({
    schemaVersion: EXECUTABLE_PLAN_SCHEMA_VERSION,
    executablePlanId: executablePlanId(validatedPlan.planId),
    sourceValidatedPlanId: validatedPlan.planId,
    inventory: structuredClone(validatedPlan.inventory),
    status: "EXECUTABLE",
    decisions,
    runtime: {
      checkedAt,
      requiredReductionTokens: validatedPlan.runtime.requiredReductionTokens,
      potentialReductionUpperBound: validatedPlan.runtime.potentialReductionUpperBound,
      actualReductionTokens: null,
      zeroMutation: true
    }
  });
}
