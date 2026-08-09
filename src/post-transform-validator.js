import { CONTEXT_UNIT_AUTHORITIES, CONTEXT_UNIT_KINDS, CONTEXT_UNIT_PROTECTED_REASONS, isContextUnitId } from "./context-unit.js";
import { EXECUTABLE_PLAN_SCHEMA_VERSION } from "./execution-preflight.js";
import {
  ACTION_OPERATION,
  TRANSFORMATION_CANDIDATE_SCHEMA_VERSION,
  TRANSFORMATION_OPERATIONS,
  contentDigest,
  deepFreeze,
  externalizedRecoveryMarker
} from "./transformation-candidate.js";
import {
  SEMANTIC_PRESERVATION_REASON_CODES,
  createTransformationRejection,
  createValidatedTransformation
} from "./validated-transformation.js";
import { estimateTokens } from "./utils.js";

const CANDIDATE_FIELDS = [
  "schemaVersion",
  "candidateId",
  "sourceExecutablePlanId",
  "inventory",
  "status",
  "decisions",
  "runtime"
];
const CANDIDATE_DECISION_FIELDS = [
  "unitId",
  "action",
  "operation",
  "sourceContentDigest",
  "candidateContent",
  "candidateContentDigest",
  "requestedTargetTokens",
  "candidateEstimatedTokens"
];
const CANDIDATE_RUNTIME_FIELDS = ["generatedAt", "zeroMutation", "actualReductionTokens"];
const PLAN_FIELDS = [
  "schemaVersion",
  "executablePlanId",
  "sourceValidatedPlanId",
  "inventory",
  "status",
  "decisions",
  "runtime"
];
const PLAN_DECISION_FIELDS = [
  "unitId",
  "action",
  "executionDisposition",
  "importance",
  "requestedTargetTokens",
  "potentialReductionUpperBound",
  "recoveryProof"
];
const PLAN_RUNTIME_FIELDS = [
  "checkedAt",
  "requiredReductionTokens",
  "potentialReductionUpperBound",
  "actualReductionTokens",
  "zeroMutation"
];
const IDENTITY_FIELDS = ["id", "fingerprint"];
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SEMANTIC_CODES = new Set(SEMANTIC_PRESERVATION_REASON_CODES);

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

function validIdentity(value) {
  return exactFields(value, IDENTITY_FIELDS)
    && typeof value.id === "string"
    && typeof value.fingerprint === "string"
    && FINGERPRINT_PATTERN.test(value.fingerprint);
}

function validCandidateDecision(decision) {
  return exactFields(decision, CANDIDATE_DECISION_FIELDS)
    && isContextUnitId(decision.unitId)
    && Object.hasOwn(ACTION_OPERATION, decision.action)
    && TRANSFORMATION_OPERATIONS.includes(decision.operation)
    && DIGEST_PATTERN.test(String(decision.sourceContentDigest ?? ""))
    && (decision.candidateContent === null || typeof decision.candidateContent === "string")
    && (decision.candidateContentDigest === null
      || DIGEST_PATTERN.test(String(decision.candidateContentDigest)))
    && (decision.requestedTargetTokens === null
      || (Number.isSafeInteger(decision.requestedTargetTokens) && decision.requestedTargetTokens > 0))
    && (decision.candidateEstimatedTokens === null
      || nonNegativeInteger(decision.candidateEstimatedTokens));
}

function validCandidate(candidate) {
  return exactFields(candidate, CANDIDATE_FIELDS)
    && candidate.schemaVersion === TRANSFORMATION_CANDIDATE_SCHEMA_VERSION
    && typeof candidate.candidateId === "string"
    && /^candidate_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(candidate.candidateId)
    && typeof candidate.sourceExecutablePlanId === "string"
    && validIdentity(candidate.inventory)
    && candidate.status === "PREPARED"
    && Array.isArray(candidate.decisions)
    && candidate.decisions.every(validCandidateDecision)
    && new Set(candidate.decisions.map((decision) => decision.unitId)).size === candidate.decisions.length
    && exactFields(candidate.runtime, CANDIDATE_RUNTIME_FIELDS)
    && typeof candidate.runtime.generatedAt === "string"
    && !Number.isNaN(Date.parse(candidate.runtime.generatedAt))
    && candidate.runtime.zeroMutation === true
    && candidate.runtime.actualReductionTokens === null;
}

function validExecutablePlan(plan) {
  return exactFields(plan, PLAN_FIELDS)
    && plan.schemaVersion === EXECUTABLE_PLAN_SCHEMA_VERSION
    && typeof plan.executablePlanId === "string"
    && validIdentity(plan.inventory)
    && plan.status === "EXECUTABLE"
    && Array.isArray(plan.decisions)
    && plan.decisions.every((decision) => (
      exactFields(decision, PLAN_DECISION_FIELDS)
      && isContextUnitId(decision.unitId)
      && Object.hasOwn(ACTION_OPERATION, decision.action)
      && (decision.requestedTargetTokens === null
        || (Number.isSafeInteger(decision.requestedTargetTokens) && decision.requestedTargetTokens > 0))
      && decision.recoveryProof
      && ["VERIFIED", "NOT_REQUIRED"].includes(decision.recoveryProof.status)
    ))
    && new Set(plan.decisions.map((decision) => decision.unitId)).size === plan.decisions.length
    && exactFields(plan.runtime, PLAN_RUNTIME_FIELDS)
    && plan.runtime.zeroMutation === true
    && plan.runtime.actualReductionTokens === null;
}

function validUnit(unit) {
  return unit
    && typeof unit === "object"
    && isContextUnitId(unit.id)
    && CONTEXT_UNIT_KINDS.includes(unit.kind)
    && CONTEXT_UNIT_AUTHORITIES.includes(unit.authority)
    && Array.isArray(unit.protectedReasons)
    && unit.protectedReasons.every((reason) => CONTEXT_UNIT_PROTECTED_REASONS.includes(reason))
    && typeof unit.content === "string";
}

function sameIdentity(left, right) {
  return left?.id === right?.id && left?.fingerprint === right?.fingerprint;
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function validSemanticAssessment(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Object.hasOwn(value, "verdict")
    && Object.hasOwn(value, "reasonCodes")
    && ["ACCEPT", "REJECT"].includes(value.verdict)
    && Array.isArray(value.reasonCodes)
    && value.reasonCodes.every((code) => SEMANTIC_CODES.has(code))
    && new Set(value.reasonCodes).size === value.reasonCodes.length
    && (value.verdict === "ACCEPT" ? value.reasonCodes.length === 0 : value.reasonCodes.length > 0);
}

export async function validateTransformation({
  candidate,
  executablePlan,
  inventory,
  semanticValidator = null,
  now = () => new Date()
} = {}) {
  const validatedAt = now().toISOString();
  const reasons = [];
  const checks = [];
  if (!validCandidate(candidate)) addReason(reasons, "INVALID_TRANSFORMATION_CANDIDATE");
  if (!validExecutablePlan(executablePlan)) addReason(reasons, "INVALID_EXECUTABLE_PLAN");
  if (reasons.length) {
    return createTransformationRejection({ candidate, inventory, validatedAt, reasonCodes: reasons });
  }

  const currentIdentity = inventory?.inventory;
  if (!validIdentity(currentIdentity)) addReason(reasons, "INVALID_TRANSFORMATION_INVENTORY");
  if (candidate.sourceExecutablePlanId !== executablePlan.executablePlanId
    || !sameIdentity(candidate.inventory, executablePlan.inventory)) {
    addReason(reasons, "CANDIDATE_EXECUTABLE_MISMATCH");
  }
  if (!sameIdentity(candidate.inventory, currentIdentity)) addReason(reasons, "TRANSFORMATION_STALE_INVENTORY");

  const units = Array.isArray(inventory?.units) ? inventory.units : [];
  const unitIds = units.map((unit) => unit.id);
  const candidateIds = candidate.decisions.map((decision) => decision.unitId);
  const planIds = executablePlan.decisions.map((decision) => decision.unitId);
  if (!Array.isArray(inventory?.units)
    || units.some((unit) => !validUnit(unit))
    || units.length !== candidate.decisions.length
    || units.length !== executablePlan.decisions.length
    || new Set(unitIds).size !== unitIds.length
    || unitIds.some((id) => !candidateIds.includes(id) || !planIds.includes(id))) {
    addReason(reasons, "INVENTORY_DECISION_MISMATCH");
  }
  if (reasons.length) {
    return createTransformationRejection({ candidate, inventory, validatedAt, reasonCodes: reasons });
  }

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const planById = new Map(executablePlan.decisions.map((decision) => [decision.unitId, decision]));
  const validatedDecisions = [];
  for (const decision of candidate.decisions) {
    const unit = unitById.get(decision.unitId);
    const executableDecision = planById.get(decision.unitId);
    const unitReasons = [];
    const expectedOperation = ACTION_OPERATION[executableDecision.action];
    if (decision.action !== executableDecision.action
      || decision.operation !== expectedOperation
      || decision.requestedTargetTokens !== executableDecision.requestedTargetTokens) {
      addReason(unitReasons, "ACTION_OPERATION_MISMATCH");
    }
    if (decision.sourceContentDigest !== contentDigest(unit.content)) {
      addReason(unitReasons, "SOURCE_CONTENT_DIGEST_MISMATCH");
    }

    const replacement = decision.operation === "REPLACE";
    const recalculatedDigest = typeof decision.candidateContent === "string"
      ? contentDigest(decision.candidateContent)
      : null;
    const recalculatedTokens = typeof decision.candidateContent === "string"
      ? estimateTokens(decision.candidateContent)
      : decision.operation === "REMOVE" ? 0 : null;
    if (decision.candidateContentDigest !== recalculatedDigest) {
      addReason(unitReasons, "CANDIDATE_CONTENT_DIGEST_MISMATCH");
    }
    if (decision.candidateEstimatedTokens !== recalculatedTokens) {
      addReason(unitReasons, "CANDIDATE_TOKEN_ESTIMATE_MISMATCH");
    }

    if (decision.action === "KEEP") {
      if (decision.operation !== "NOOP"
        || decision.candidateContent !== null
        || decision.candidateContentDigest !== null
        || decision.candidateEstimatedTokens !== null) {
        addReason(unitReasons, "INVALID_NOOP_CANDIDATE");
      }
    } else if (decision.action === "PROMOTE_PROPOSAL") {
      if (decision.operation !== "AUDIT_ONLY"
        || decision.candidateContent !== null
        || decision.candidateContentDigest !== null
        || decision.candidateEstimatedTokens !== null) {
        addReason(unitReasons, "INVALID_AUDIT_ONLY_CANDIDATE");
      }
    } else if (decision.action === "EVICT") {
      if (decision.operation !== "REMOVE"
        || decision.candidateContent !== null
        || decision.candidateContentDigest !== null
        || decision.candidateEstimatedTokens !== 0) {
        addReason(unitReasons, "INVALID_REMOVE_CANDIDATE");
      }
    } else if (decision.action === "EXTERNALIZE") {
      let expectedMarker = null;
      try {
        expectedMarker = externalizedRecoveryMarker({
          unit,
          recoveryProof: executableDecision.recoveryProof
        });
      } catch {
        addReason(unitReasons, "INVALID_EXTERNALIZE_MARKER");
      }
      if (decision.operation !== "REPLACE" || decision.candidateContent !== expectedMarker) {
        addReason(unitReasons, "INVALID_EXTERNALIZE_MARKER");
      }
    } else if (decision.action === "COMPRESS") {
      const sourceTokens = estimateTokens(unit.content);
      if (!replacement || typeof decision.candidateContent !== "string" || !decision.candidateContent.trim()) {
        addReason(unitReasons, "EMPTY_COMPRESSION_CANDIDATE");
      } else {
        if (recalculatedTokens <= 0) addReason(unitReasons, "EMPTY_COMPRESSION_CANDIDATE");
        if (recalculatedTokens >= sourceTokens) addReason(unitReasons, "COMPRESSION_NOT_REDUCED");
        if (recalculatedTokens > executableDecision.requestedTargetTokens) {
          addReason(unitReasons, "TARGET_TOKEN_EXCEEDED");
        }
      }
    }

    checks.push({ unitId: decision.unitId, reasonCodes: [...unitReasons] });
    for (const code of unitReasons) addReason(reasons, code);
    validatedDecisions.push({
      unitId: decision.unitId,
      action: decision.action,
      operation: decision.operation,
      permission: "APPROVED",
      sourceContentDigest: decision.sourceContentDigest,
      candidateContentDigest: decision.candidateContentDigest,
      validatedCandidateTokens: recalculatedTokens
    });
  }
  if (reasons.length) {
    return createTransformationRejection({ candidate, inventory, validatedAt, reasonCodes: reasons, checks });
  }

  for (const decision of candidate.decisions.filter((entry) => entry.action === "COMPRESS")) {
    if (!semanticValidator || typeof semanticValidator.assess !== "function") {
      return createTransformationRejection({
        candidate,
        inventory,
        validatedAt,
        reasonCodes: ["SEMANTIC_VALIDATOR_UNAVAILABLE"],
        checks
      });
    }
    const unit = unitById.get(decision.unitId);
    let assessment;
    try {
      assessment = await semanticValidator.assess(deepFreeze({
        schemaVersion: 1,
        originalContent: unit.content,
        candidateContent: decision.candidateContent,
        kind: unit.kind,
        authority: unit.authority,
        protectedReasons: [...unit.protectedReasons]
      }));
    } catch (error) {
      return createTransformationRejection({
        candidate,
        inventory,
        validatedAt,
        reasonCodes: [error?.code ?? "SEMANTIC_VALIDATION_FAILED"],
        checks
      });
    }
    if (!validSemanticAssessment(assessment)) {
      return createTransformationRejection({
        candidate,
        inventory,
        validatedAt,
        reasonCodes: ["SEMANTIC_VALIDATION_FAILED"],
        checks
      });
    }
    if (assessment.verdict === "REJECT") {
      return createTransformationRejection({
        candidate,
        inventory,
        validatedAt,
        reasonCodes: assessment.reasonCodes,
        checks: [...checks, { unitId: decision.unitId, reasonCodes: [...assessment.reasonCodes] }]
      });
    }
  }

  return createValidatedTransformation({ candidate, decisions: validatedDecisions, validatedAt });
}
