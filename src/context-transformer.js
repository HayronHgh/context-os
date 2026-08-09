import { CONTEXT_UNIT_AUTHORITIES, CONTEXT_UNIT_KINDS, CONTEXT_UNIT_RECOVERABILITY, isContextUnitId } from "./context-unit.js";
import { COMPACTION_IMPORTANCE } from "./compaction-plan.js";
import { EXECUTABLE_PLAN_SCHEMA_VERSION } from "./execution-preflight.js";
import { RECOVERY_PROOF_SCHEMA_VERSION } from "./recovery-verifier.js";
import {
  ACTION_OPERATION,
  createCandidateDecision,
  createTransformationCandidate,
  deepFreeze,
  externalizedRecoveryMarker
} from "./transformation-candidate.js";

export const TRANSFORMATION_FAILURE_SCHEMA_VERSION = 1;

const PLAN_FIELDS = [
  "schemaVersion",
  "executablePlanId",
  "sourceValidatedPlanId",
  "inventory",
  "status",
  "decisions",
  "runtime"
];
const IDENTITY_FIELDS = ["id", "fingerprint"];
const DECISION_FIELDS = [
  "unitId",
  "action",
  "executionDisposition",
  "importance",
  "requestedTargetTokens",
  "potentialReductionUpperBound",
  "recoveryProof"
];
const RUNTIME_FIELDS = [
  "checkedAt",
  "requiredReductionTokens",
  "potentialReductionUpperBound",
  "actualReductionTokens",
  "zeroMutation"
];
const RECOVERY_PROOF_FIELDS = [
  "schemaVersion",
  "unitId",
  "action",
  "sourceType",
  "checkedAt",
  "status",
  "code",
  "detail",
  "evidence"
];
const ACTION_DISPOSITION = Object.freeze({
  KEEP: "NOOP",
  PROMOTE_PROPOSAL: "AUDIT_ONLY",
  EVICT: "READY",
  EXTERNALIZE: "READY",
  COMPRESS: "READY"
});
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

function exactFields(value, fields) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => fields.includes(field));
}

function validIdentity(value) {
  return exactFields(value, IDENTITY_FIELDS)
    && typeof value.id === "string"
    && FINGERPRINT_PATTERN.test(value.fingerprint);
}

function validExecutableDecision(decision) {
  if (!exactFields(decision, DECISION_FIELDS)
    || !isContextUnitId(decision.unitId)
    || !Object.hasOwn(ACTION_OPERATION, decision.action)
    || decision.executionDisposition !== ACTION_DISPOSITION[decision.action]
    || (decision.importance !== null && !COMPACTION_IMPORTANCE.includes(decision.importance))
    || !Number.isSafeInteger(decision.potentialReductionUpperBound)
    || decision.potentialReductionUpperBound < 0
    || !validRecoveryProof(decision.recoveryProof, decision)) return false;
  if (decision.action === "COMPRESS") {
    return Number.isSafeInteger(decision.requestedTargetTokens) && decision.requestedTargetTokens > 0;
  }
  return decision.requestedTargetTokens === null;
}

function validRecoveryProof(proof, decision) {
  if (!exactFields(proof, RECOVERY_PROOF_FIELDS)
    || proof.schemaVersion !== RECOVERY_PROOF_SCHEMA_VERSION
    || proof.unitId !== decision.unitId
    || proof.action !== decision.action
    || !CONTEXT_UNIT_RECOVERABILITY.includes(proof.sourceType)
    || typeof proof.checkedAt !== "string"
    || Number.isNaN(Date.parse(proof.checkedAt))
    || !["VERIFIED", "NOT_REQUIRED"].includes(proof.status)
    || proof.code !== null) return false;
  if (proof.status === "VERIFIED") {
    return proof.detail === null
      && proof.evidence
      && typeof proof.evidence === "object"
      && !Array.isArray(proof.evidence);
  }
  return typeof proof.detail === "string" && proof.evidence === null;
}

function validExecutablePlan(plan) {
  return exactFields(plan, PLAN_FIELDS)
    && plan.schemaVersion === EXECUTABLE_PLAN_SCHEMA_VERSION
    && typeof plan.executablePlanId === "string"
    && /^exec_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(plan.executablePlanId)
    && typeof plan.sourceValidatedPlanId === "string"
    && validIdentity(plan.inventory)
    && plan.status === "EXECUTABLE"
    && Array.isArray(plan.decisions)
    && plan.decisions.every(validExecutableDecision)
    && new Set(plan.decisions.map((decision) => decision.unitId)).size === plan.decisions.length
    && exactFields(plan.runtime, RUNTIME_FIELDS)
    && typeof plan.runtime.checkedAt === "string"
    && !Number.isNaN(Date.parse(plan.runtime.checkedAt))
    && Number.isSafeInteger(plan.runtime.requiredReductionTokens)
    && plan.runtime.requiredReductionTokens >= 0
    && Number.isSafeInteger(plan.runtime.potentialReductionUpperBound)
    && plan.runtime.potentialReductionUpperBound >= 0
    && plan.runtime.actualReductionTokens === null
    && plan.runtime.zeroMutation === true;
}

function validUnit(unit) {
  return unit
    && typeof unit === "object"
    && isContextUnitId(unit.id)
    && CONTEXT_UNIT_KINDS.includes(unit.kind)
    && CONTEXT_UNIT_AUTHORITIES.includes(unit.authority)
    && CONTEXT_UNIT_RECOVERABILITY.includes(unit.recoverability)
    && (unit.recoveryRef === null
      || (typeof unit.recoveryRef === "object" && !Array.isArray(unit.recoveryRef)))
    && Number.isSafeInteger(unit.tokens)
    && unit.tokens >= 0
    && typeof unit.content === "string";
}

function identityOf(inventory) {
  return inventory?.inventory && typeof inventory.inventory === "object"
    ? { id: inventory.inventory.id, fingerprint: inventory.inventory.fingerprint }
    : null;
}

function failure({ executablePlan, inventory, generatedAt, status, code, detail = null }) {
  return deepFreeze({
    schemaVersion: TRANSFORMATION_FAILURE_SCHEMA_VERSION,
    status,
    sourceExecutablePlanId: typeof executablePlan?.executablePlanId === "string"
      ? executablePlan.executablePlanId
      : null,
    inventory: identityOf(inventory),
    reasonCodes: [code],
    error: detail == null ? null : { code, detail: String(detail).slice(0, 500) },
    candidate: null,
    runtime: {
      generatedAt,
      zeroMutation: true,
      actualReductionTokens: null
    }
  });
}

export async function prepareTransformation({
  executablePlan,
  inventory,
  transformer = null,
  now = () => new Date()
} = {}) {
  const generatedAt = now().toISOString();
  if (!validExecutablePlan(executablePlan)) {
    return failure({
      executablePlan,
      inventory,
      generatedAt,
      status: "TRANSFORMATION_FAILED",
      code: "INVALID_EXECUTABLE_PLAN"
    });
  }
  const currentIdentity = identityOf(inventory);
  if (!validIdentity(currentIdentity)) {
    return failure({
      executablePlan,
      inventory,
      generatedAt,
      status: "TRANSFORMATION_FAILED",
      code: "INVALID_TRANSFORMATION_INVENTORY"
    });
  }
  if (currentIdentity.id !== executablePlan.inventory.id
    || currentIdentity.fingerprint !== executablePlan.inventory.fingerprint) {
    return failure({
      executablePlan,
      inventory,
      generatedAt,
      status: "TRANSFORMATION_STALE_INVENTORY",
      code: "TRANSFORMATION_STALE_INVENTORY"
    });
  }
  const units = Array.isArray(inventory?.units) ? inventory.units : [];
  const unitIds = units.map((unit) => unit.id);
  const decisionIds = executablePlan.decisions.map((decision) => decision.unitId);
  if (!Array.isArray(inventory?.units)
    || units.some((unit) => !validUnit(unit))
    || units.length !== executablePlan.decisions.length
    || new Set(unitIds).size !== unitIds.length
    || unitIds.some((id) => !decisionIds.includes(id))) {
    return failure({
      executablePlan,
      inventory,
      generatedAt,
      status: "TRANSFORMATION_FAILED",
      code: "TRANSFORMATION_INVENTORY_MISMATCH"
    });
  }

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  if (executablePlan.decisions.some((decision) => (
    decision.recoveryProof.sourceType !== unitById.get(decision.unitId).recoverability
  ))) {
    return failure({
      executablePlan,
      inventory,
      generatedAt,
      status: "TRANSFORMATION_FAILED",
      code: "EXECUTABLE_PLAN_SOURCE_MISMATCH"
    });
  }
  const decisions = [];
  try {
    for (const decision of executablePlan.decisions) {
      const unit = unitById.get(decision.unitId);
      let candidateContent = null;
      if (decision.action === "EXTERNALIZE") {
        candidateContent = externalizedRecoveryMarker({ unit, recoveryProof: decision.recoveryProof });
      } else if (decision.action === "COMPRESS") {
        if (!transformer || typeof transformer.compress !== "function") {
          throw new Error("COMPRESS requires a transformer with compress(input)");
        }
        candidateContent = await transformer.compress(deepFreeze({
          schemaVersion: 1,
          unitId: unit.id,
          kind: unit.kind,
          authority: unit.authority,
          targetTokens: decision.requestedTargetTokens,
          content: unit.content
        }));
        if (typeof candidateContent !== "string" || !candidateContent.trim()) {
          throw new Error("Transformer returned no candidate content");
        }
      }
      decisions.push(createCandidateDecision({ decision, unit, candidateContent }));
    }
  } catch (error) {
    return failure({
      executablePlan,
      inventory,
      generatedAt,
      status: "TRANSFORMATION_FAILED",
      code: error?.code ?? "TRANSFORMER_FAILED",
      detail: error?.message ?? error
    });
  }

  return createTransformationCandidate({ executablePlan, decisions, generatedAt });
}
