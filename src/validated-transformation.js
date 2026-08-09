import { deepFreeze } from "./transformation-candidate.js";

export const VALIDATED_TRANSFORMATION_SCHEMA_VERSION = 1;

export const SEMANTIC_PRESERVATION_REASON_CODES = Object.freeze([
  "CONSTRAINT_LOST",
  "FACT_LOST",
  "DECISION_LOST",
  "IDENTIFIER_LOST",
  "ERROR_STATE_LOST",
  "UNRESOLVED_STATE_LOST",
  "FABRICATION_ADDED",
  "MEANING_CHANGED"
]);

export function createValidatedTransformation({ candidate, decisions, validatedAt }) {
  return deepFreeze({
    schemaVersion: VALIDATED_TRANSFORMATION_SCHEMA_VERSION,
    validationId: `validation_${candidate.candidateId.slice("candidate_".length)}`,
    sourceCandidateId: candidate.candidateId,
    inventory: structuredClone(candidate.inventory),
    status: "VALIDATED",
    decisions: structuredClone(decisions),
    runtime: {
      validatedAt,
      zeroMutation: true,
      actualReductionTokens: null
    }
  });
}

export function createTransformationRejection({
  candidate,
  inventory,
  validatedAt,
  reasonCodes,
  checks = []
}) {
  const identity = inventory?.inventory && typeof inventory.inventory === "object"
    ? { id: inventory.inventory.id, fingerprint: inventory.inventory.fingerprint }
    : null;
  return deepFreeze({
    schemaVersion: VALIDATED_TRANSFORMATION_SCHEMA_VERSION,
    status: "TRANSFORMATION_REJECTED",
    sourceCandidateId: typeof candidate?.candidateId === "string" ? candidate.candidateId : null,
    inventory: identity,
    reasonCodes: [...new Set(reasonCodes)],
    checks: structuredClone(checks),
    validatedTransformation: null,
    runtime: {
      validatedAt,
      zeroMutation: true,
      actualReductionTokens: null
    }
  });
}
