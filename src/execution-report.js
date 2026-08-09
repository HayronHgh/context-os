import { deepFreeze } from "./transformation-candidate.js";

export const EXECUTION_REPORT_SCHEMA_VERSION = 1;

export const EXECUTION_REPORT_STATUSES = Object.freeze([
  "FINALIZED",
  "EXECUTION_FINALIZATION_FAILED"
]);

export const EXECUTION_FINALIZATION_REASON_CODES = Object.freeze([
  "INVALID_EXECUTION_RESULT",
  "FINALIZATION_STALE_CONTEXT",
  "FINALIZATION_INVENTORY_MISMATCH",
  "INVENTORY_REBUILD_FAILED",
  "ACCOUNTING_IDENTITY_MISMATCH",
  "TOKEN_ACCOUNTING_FAILED"
]);

function unique(values) {
  return [...new Set(values)];
}

export function createExecutionReport({
  executionResult,
  inventoryAfter,
  tokensAfter,
  actualReductionTokens,
  finalizedAt,
  contextGeneration
}) {
  return deepFreeze({
    schemaVersion: EXECUTION_REPORT_SCHEMA_VERSION,
    reportId: `report_${executionResult.executionId.slice("execution_".length)}`,
    sourceExecutionId: executionResult.executionId,
    status: "FINALIZED",
    executionCommitted: true,
    inventoryBefore: structuredClone(executionResult.inventoryBefore),
    inventoryAfter: structuredClone(inventoryAfter),
    tokens: {
      before: structuredClone(executionResult.runtime.tokenAccountingBefore),
      after: structuredClone(tokensAfter),
      potentialReductionUpperBound: executionResult.potentialReductionUpperBound,
      actualReductionTokens
    },
    runtime: {
      finalizedAt,
      contextGeneration
    }
  });
}

export function createExecutionFinalizationFailure({
  executionResult,
  reasonCodes,
  failedAt,
  contextGeneration = null,
  checks = []
}) {
  return deepFreeze({
    schemaVersion: EXECUTION_REPORT_SCHEMA_VERSION,
    reportId: null,
    sourceExecutionId: typeof executionResult?.executionId === "string"
      ? executionResult.executionId
      : null,
    status: "EXECUTION_FINALIZATION_FAILED",
    executionCommitted: executionResult?.status === "COMMITTED" && executionResult?.committed === true,
    reasonCodes: unique(reasonCodes),
    checks: structuredClone(checks),
    actualReductionTokens: null,
    runtime: {
      failedAt,
      contextGeneration: Number.isSafeInteger(contextGeneration) ? contextGeneration : null
    }
  });
}
