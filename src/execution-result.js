import { deepFreeze } from "./transformation-candidate.js";

export const EXECUTION_RESULT_SCHEMA_VERSION = 1;

export const EXECUTION_STATUSES = Object.freeze([
  "COMMITTED",
  "EXECUTION_ABORTED"
]);

export const EXECUTION_REASON_CODES = Object.freeze([
  "INVALID_VALIDATED_TRANSFORMATION",
  "EXECUTION_CHAIN_MISMATCH",
  "EXECUTION_STALE_CONTEXT",
  "SOURCE_CONTENT_CHANGED",
  "CANDIDATE_CONTENT_CHANGED",
  "RECOVERY_REVALIDATION_FAILED",
  "EXECUTION_ALREADY_CONSUMED",
  "EXECUTION_BUILD_FAILED",
  "EXECUTION_COMMIT_FAILED"
]);

function unique(values) {
  return [...new Set(values)];
}

export function createExecutionResult({
  validatedTransformation,
  inventoryBefore,
  operations,
  committedAt,
  generationBefore,
  generationAfter
}) {
  return deepFreeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    executionId: `execution_${validatedTransformation.validationId.slice("validation_".length)}`,
    sourceValidationId: validatedTransformation.validationId,
    status: "COMMITTED",
    inventoryBefore: structuredClone(inventoryBefore),
    operations: structuredClone(operations),
    committed: true,
    runtime: {
      committedAt,
      contextGenerationBefore: generationBefore,
      contextGenerationAfter: generationAfter
    }
  });
}

export function createExecutionAbort({
  validatedTransformation,
  inventory,
  reasonCodes,
  abortedAt,
  checks = []
}) {
  const identity = inventory?.inventory && typeof inventory.inventory === "object"
    ? { id: inventory.inventory.id, fingerprint: inventory.inventory.fingerprint }
    : null;
  return deepFreeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    executionId: null,
    sourceValidationId: typeof validatedTransformation?.validationId === "string"
      ? validatedTransformation.validationId
      : null,
    status: "EXECUTION_ABORTED",
    inventoryBefore: identity,
    reasonCodes: unique(reasonCodes),
    checks: structuredClone(checks),
    committed: false,
    runtime: {
      abortedAt
    }
  });
}
