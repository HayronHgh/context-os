import { isContextUnitId } from "./context-unit.js";
import {
  TRANSFORMATION_OPERATIONS,
  contentDigest,
  deepFreeze
} from "./transformation-candidate.js";

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

export function accountingToolsDigest(tools) {
  if (!Array.isArray(tools)) throw new Error("Execution accounting tools must be an array");
  return contentDigest(JSON.stringify(canonicalize(structuredClone(tools))));
}

export function validTokenBreakdown(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Number.isSafeInteger(value.messageTokens)
    || value.messageTokens < 0
    || !Number.isSafeInteger(value.toolTokens)
    || value.toolTokens < 0
    || !Number.isSafeInteger(value.fixedPromptOverheadTokens)
    || value.fixedPromptOverheadTokens < 0
    || !Number.isSafeInteger(value.totalTokens)
    || value.totalTokens < 0) return false;
  return Object.keys(value).length === 4
    && value.totalTokens === value.messageTokens
      + value.toolTokens
      + value.fixedPromptOverheadTokens;
}

export function isCommittedExecutionResult(value) {
  const identity = value?.inventoryBefore;
  const runtime = value?.runtime;
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 9
    && value.schemaVersion === EXECUTION_RESULT_SCHEMA_VERSION
    && /^execution_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(String(value.executionId ?? ""))
    && /^validation_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(String(value.sourceValidationId ?? ""))
    && value.executionId === `execution_${value.sourceValidationId.slice("validation_".length)}`
    && value.status === "COMMITTED"
    && identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && Object.keys(identity).length === 2
    && typeof identity.id === "string"
    && /^sha256:[a-f0-9]{64}$/.test(String(identity.fingerprint ?? ""))
    && Array.isArray(value.operations)
    && value.operations.every((operation) => (
      operation
      && typeof operation === "object"
      && !Array.isArray(operation)
      && Object.keys(operation).length === 2
      && isContextUnitId(operation.unitId)
      && TRANSFORMATION_OPERATIONS.includes(operation.operation)
    ))
    && new Set(value.operations.map((operation) => operation.unitId)).size === value.operations.length
    && Number.isSafeInteger(value.potentialReductionUpperBound)
    && value.potentialReductionUpperBound >= 0
    && value.committed === true
    && runtime
    && typeof runtime === "object"
    && !Array.isArray(runtime)
    && Object.keys(runtime).length === 5
    && typeof runtime.committedAt === "string"
    && !Number.isNaN(Date.parse(runtime.committedAt))
    && Number.isSafeInteger(runtime.contextGenerationBefore)
    && runtime.contextGenerationBefore >= 0
    && runtime.contextGenerationAfter === runtime.contextGenerationBefore + 1
    && validTokenBreakdown(runtime.tokenAccountingBefore)
    && /^sha256:[a-f0-9]{64}$/.test(String(runtime.accountingToolsDigest ?? ""));
}

export function createExecutionResult({
  validatedTransformation,
  inventoryBefore,
  operations,
  potentialReductionUpperBound,
  tokenAccountingBefore,
  toolsDigest,
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
    potentialReductionUpperBound,
    committed: true,
    runtime: {
      committedAt,
      contextGenerationBefore: generationBefore,
      contextGenerationAfter: generationAfter,
      tokenAccountingBefore: structuredClone(tokenAccountingBefore),
      accountingToolsDigest: toolsDigest
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
