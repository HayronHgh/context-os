import { createHash } from "node:crypto";
import { estimateTokens } from "./utils.js";

export const TRANSFORMATION_CANDIDATE_SCHEMA_VERSION = 1;

export const TRANSFORMATION_OPERATIONS = Object.freeze([
  "NOOP",
  "REMOVE",
  "REPLACE",
  "AUDIT_ONLY"
]);

export const ACTION_OPERATION = Object.freeze({
  KEEP: "NOOP",
  EVICT: "REMOVE",
  EXTERNALIZE: "REPLACE",
  COMPRESS: "REPLACE",
  PROMOTE_PROPOSAL: "AUDIT_ONLY"
});

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

export function contentDigest(content) {
  if (typeof content !== "string") throw new Error("Transformation content must be a string");
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function externalizedRecoveryMarker({ unit, recoveryProof }) {
  if (!unit || typeof unit !== "object" || unit.recoverability === "none" || !unit.recoveryRef) {
    throw new Error("EXTERNALIZE requires a Runtime-owned recovery reference");
  }
  if (recoveryProof?.status !== "VERIFIED" || recoveryProof.sourceType !== unit.recoverability) {
    throw new Error("EXTERNALIZE requires a matching verified recovery proof");
  }
  const payload = canonicalize({
    schemaVersion: 1,
    unitId: unit.id,
    recovery: {
      type: unit.recoverability,
      reference: structuredClone(unit.recoveryRef)
    }
  });
  return `[context-os:externalized ${JSON.stringify(payload)}]`;
}

export function createCandidateDecision({ decision, unit, candidateContent = null }) {
  const operation = ACTION_OPERATION[decision?.action];
  if (!TRANSFORMATION_OPERATIONS.includes(operation)) {
    throw new Error(`Unsupported transformation action: ${decision?.action}`);
  }
  const replacement = operation === "REPLACE";
  if (replacement && typeof candidateContent !== "string") {
    throw new Error(`${decision.action} requires candidate content`);
  }
  if (!replacement && candidateContent !== null) {
    throw new Error(`${decision.action} cannot carry candidate content`);
  }
  return deepFreeze({
    unitId: decision.unitId,
    action: decision.action,
    operation,
    sourceContentDigest: contentDigest(unit.content),
    candidateContent,
    candidateContentDigest: replacement ? contentDigest(candidateContent) : null,
    requestedTargetTokens: decision.requestedTargetTokens,
    candidateEstimatedTokens: replacement
      ? estimateTokens(candidateContent)
      : operation === "REMOVE" ? 0 : null
  });
}

export function createTransformationCandidate({ executablePlan, decisions, generatedAt }) {
  return deepFreeze({
    schemaVersion: TRANSFORMATION_CANDIDATE_SCHEMA_VERSION,
    candidateId: `candidate_${executablePlan.executablePlanId.slice("exec_".length)}`,
    sourceExecutablePlanId: executablePlan.executablePlanId,
    inventory: structuredClone(executablePlan.inventory),
    status: "PREPARED",
    decisions: structuredClone(decisions),
    runtime: {
      generatedAt,
      zeroMutation: true,
      actualReductionTokens: null
    }
  });
}
