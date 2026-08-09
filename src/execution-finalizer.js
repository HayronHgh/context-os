import { ContextInventory } from "./context-inventory.js";
import { ContextManager } from "./context-manager.js";
import {
  accountingToolsDigest,
  isCommittedExecutionResult,
  validTokenBreakdown
} from "./execution-result.js";
import {
  createExecutionFinalizationFailure,
  createExecutionReport
} from "./execution-report.js";

function sameIdentity(left, right) {
  return left?.id === right?.id && left?.fingerprint === right?.fingerprint;
}

function validContext(context) {
  return context
    && typeof context === "object"
    && !Array.isArray(context)
    && Array.isArray(context.messages)
    && Number.isSafeInteger(context.contextGeneration)
    && context.contextGeneration >= 0;
}

export function finalizeExecution({
  executionResult,
  context,
  contextInventory,
  contextManager,
  tools = [],
  taskId = null,
  now = () => new Date()
} = {}) {
  const failedAt = now().toISOString();
  const fail = (reasonCodes, checks = []) => createExecutionFinalizationFailure({
    executionResult,
    reasonCodes,
    checks,
    failedAt,
    contextGeneration: context?.contextGeneration
  });

  if (!isCommittedExecutionResult(executionResult)) {
    return fail(["INVALID_EXECUTION_RESULT"]);
  }
  if (!validContext(context)
    || !(contextInventory instanceof ContextInventory)
    || !(contextManager instanceof ContextManager)
    || !Array.isArray(tools)
    || (taskId !== null && typeof taskId !== "string")) {
    return fail(["INVALID_EXECUTION_RESULT"]);
  }
  if (context.contextGeneration !== executionResult.runtime.contextGenerationAfter) {
    return fail(["FINALIZATION_STALE_CONTEXT"]);
  }
  const committedMessages = context.messages;
  let toolsDigest;
  try {
    toolsDigest = accountingToolsDigest(tools);
  } catch {
    return fail(["ACCOUNTING_IDENTITY_MISMATCH"]);
  }
  if (toolsDigest !== executionResult.runtime.accountingToolsDigest) {
    return fail(["ACCOUNTING_IDENTITY_MISMATCH"]);
  }

  let inventoryBefore;
  try {
    inventoryBefore = contextInventory.snapshot().inventory;
  } catch {
    return fail(["FINALIZATION_INVENTORY_MISMATCH"]);
  }
  if (!sameIdentity(inventoryBefore, executionResult.inventoryBefore)) {
    return fail(["FINALIZATION_INVENTORY_MISMATCH"]);
  }

  let inventoryAfter;
  try {
    inventoryAfter = contextInventory.synchronize(context.messages, { taskId }).inventory;
  } catch (error) {
    return fail(["INVENTORY_REBUILD_FAILED"], [{
      detail: String(error?.message ?? error).slice(0, 500)
    }]);
  }
  if (context.contextGeneration !== executionResult.runtime.contextGenerationAfter
    || context.messages !== committedMessages) {
    return fail(["FINALIZATION_STALE_CONTEXT"]);
  }

  let tokensAfter;
  try {
    tokensAfter = contextManager.estimateComponents(context.messages, tools);
  } catch (error) {
    return fail(["TOKEN_ACCOUNTING_FAILED"], [{
      detail: String(error?.message ?? error).slice(0, 500)
    }]);
  }
  const tokensBefore = executionResult.runtime.tokenAccountingBefore;
  if (!validTokenBreakdown(tokensAfter)
    || tokensAfter.toolTokens !== tokensBefore.toolTokens
    || tokensAfter.fixedPromptOverheadTokens !== tokensBefore.fixedPromptOverheadTokens) {
    return fail(["ACCOUNTING_IDENTITY_MISMATCH"]);
  }

  const actualReductionTokens = tokensBefore.totalTokens - tokensAfter.totalTokens;
  return createExecutionReport({
    executionResult,
    inventoryAfter,
    tokensAfter,
    actualReductionTokens,
    finalizedAt: now().toISOString(),
    contextGeneration: context.contextGeneration
  });
}
