import assert from "node:assert/strict";
import test from "node:test";
import { AtomicExecutor } from "../src/atomic-executor.js";
import { validateCompactionAuthorization } from "../src/compaction-validator.js";
import { ContextInventory } from "../src/context-inventory.js";
import { ContextManager } from "../src/context-manager.js";
import { prepareTransformation } from "../src/context-transformer.js";
import { preflightValidatedPlan } from "../src/execution-preflight.js";
import { finalizeExecution } from "../src/execution-finalizer.js";
import { validateTransformation } from "../src/post-transform-validator.js";
import { RecoveryVerifier } from "../src/recovery-verifier.js";

const fixedNow = () => new Date("2026-08-10T10:00:00.000Z");
const sourceToCompress = "Constraint OMEGA remains. Identifier API_77 and error E_FINAL are unresolved. ".repeat(35);
const compressed = "Keep OMEGA, API_77, and unresolved E_FINAL.";
const tools = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a repository file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
}];
const contextConfig = {
  contextWindow: 32768,
  reservedOutputTokens: 4096,
  fixedPromptOverheadTokens: 256,
  maxToolOutputChars: 12000,
  thresholds: { garbageCollect: 0.55, prune: 0.65, semanticCompact: 0.72, hardTransfer: 0.8, failure: 0.9 }
};

function metadata({ id, kind, authority, recoverability = "none", recoveryRef = null }) {
  return {
    contextUnitId: id,
    contextUnitCreatedAt: "2026-08-10T00:00:00.000Z",
    contextUnit: {
      kind,
      authority,
      recoverability,
      recoveryRef,
      protectedReasons: [],
      dependencies: []
    }
  };
}

function normalMessages() {
  return [
    { role: "system", content: "Runtime system prompt." },
    {
      role: "user",
      content: "Keep the latest requirement.",
      context_os: metadata({
        id: "cu_finalize_000001",
        kind: "USER_CONTEXT",
        authority: "USER"
      })
    },
    {
      role: "assistant",
      content: "Artifact-backed evidence that may be evicted.",
      context_os: metadata({
        id: "cu_finalize_000002",
        kind: "TOOL_EVIDENCE",
        authority: "EVIDENCE",
        recoverability: "artifact",
        recoveryRef: { artifactId: "artifact-finalize-1", sha256: "a".repeat(64) }
      })
    },
    {
      role: "assistant",
      content: "Repository-backed snapshot that may be externalized.",
      context_os: metadata({
        id: "cu_finalize_000003",
        kind: "FILE_SNAPSHOT",
        authority: "SOURCE_OF_TRUTH",
        recoverability: "repository",
        recoveryRef: { path: "src/final.js", sha256: "b".repeat(64) }
      })
    },
    {
      role: "assistant",
      content: sourceToCompress,
      context_os: metadata({
        id: "cu_finalize_000004",
        kind: "REASONING",
        authority: "DERIVED"
      })
    }
  ];
}

function negativeMessages() {
  return [
    { role: "system", content: "S" },
    {
      role: "user",
      content: "Keep.",
      context_os: metadata({
        id: "cu_negative_000001",
        kind: "USER_CONTEXT",
        authority: "USER"
      })
    },
    {
      role: "assistant",
      content: "x",
      context_os: metadata({
        id: "cu_negative_000002",
        kind: "FILE_SNAPSHOT",
        authority: "SOURCE_OF_TRUTH",
        recoverability: "repository",
        recoveryRef: { path: "x", sha256: "c".repeat(64) }
      })
    }
  ];
}

function verifier() {
  return new RecoveryVerifier({
    providers: {
      artifact: async ({ recoveryRef }) => ({ verified: true, evidence: { artifactId: recoveryRef.artifactId } }),
      repository: async ({ recoveryRef }) => ({ verified: true, evidence: { path: recoveryRef.path } })
    },
    now: fixedNow
  });
}

async function pipeline({ negative = false } = {}) {
  const messages = negative ? negativeMessages() : normalMessages();
  const contextInventory = new ContextInventory({ sessionId: negative ? "negative" : "finalize", now: fixedNow });
  contextInventory.synchronize(messages, { taskId: "finalization-task" });
  const inventory = contextInventory.snapshot({ includeContent: true });
  const plan = negative
    ? {
        schemaVersion: 1,
        planId: "plan_negative_accounting",
        inventory: structuredClone(inventory.inventory),
        decisions: [
          { unitId: "cu_negative_000002", action: "EXTERNALIZE", importance: "low", reason: "measure expansion" }
        ]
      }
    : {
        schemaVersion: 1,
        planId: "plan_execution_finalization",
        inventory: structuredClone(inventory.inventory),
        decisions: [
          { unitId: "cu_finalize_000002", action: "EVICT", importance: "low", reason: "durable" },
          { unitId: "cu_finalize_000003", action: "EXTERNALIZE", importance: "medium", reason: "repository" },
          { unitId: "cu_finalize_000004", action: "COMPRESS", targetTokens: 60, importance: "low", reason: "verbose" }
        ]
      };
  const validatedPlan = validateCompactionAuthorization({
    plan,
    inventory,
    pressure: { requiredReductionTokens: negative ? 1 : 500 }
  });
  const recoveryVerifier = verifier();
  const executablePlan = await preflightValidatedPlan({
    validatedPlan,
    inventory,
    recoveryVerifier,
    now: fixedNow
  });
  assert.equal(executablePlan.status, "EXECUTABLE");
  const calls = { transform: 0, semantic: 0 };
  const candidate = await prepareTransformation({
    executablePlan,
    inventory,
    transformer: negative ? null : {
      compress: async () => {
        calls.transform += 1;
        return compressed;
      }
    },
    now: fixedNow
  });
  const validatedTransformation = await validateTransformation({
    candidate,
    executablePlan,
    inventory,
    semanticValidator: negative ? null : {
      assess: async () => {
        calls.semantic += 1;
        return { verdict: "ACCEPT", reasonCodes: [] };
      }
    },
    now: fixedNow
  });
  assert.equal(validatedTransformation.status, "VALIDATED");
  const contextManager = new ContextManager(contextConfig);
  const context = { messages, contextGeneration: 20 };
  const messagesBefore = structuredClone(messages);
  const executionResult = await new AtomicExecutor({ now: fixedNow }).execute({
    validatedTransformation,
    candidate,
    executablePlan,
    inventory,
    context,
    recoveryVerifier,
    contextManager,
    tools
  });
  assert.equal(executionResult.status, "COMMITTED");
  return {
    calls,
    context,
    contextInventory,
    contextManager,
    executionResult,
    inventory,
    messagesBefore,
    tools
  };
}

function finalize(value, overrides = {}) {
  return finalizeExecution({
    executionResult: value.executionResult,
    context: value.context,
    contextInventory: value.contextInventory,
    contextManager: value.contextManager,
    tools: value.tools,
    taskId: "finalization-task",
    now: fixedNow,
    ...overrides
  });
}

test("D6 rebuilds the existing inventory and emits canonical signed accounting", async () => {
  const value = await pipeline();
  const committedMessages = value.context.messages;
  const expectedBefore = value.contextManager.estimateComponents(value.messagesBefore, value.tools);
  const expectedAfter = value.contextManager.estimateComponents(committedMessages, value.tools);

  const report = finalize(value);

  assert.equal(report.status, "FINALIZED");
  assert.equal(report.executionCommitted, true);
  assert.equal(report.sourceExecutionId, value.executionResult.executionId);
  assert.notDeepEqual(report.inventoryAfter, report.inventoryBefore);
  assert.deepEqual(report.tokens.before, expectedBefore);
  assert.deepEqual(report.tokens.after, expectedAfter);
  assert.equal(report.tokens.before.toolTokens, report.tokens.after.toolTokens);
  assert.equal(report.tokens.before.fixedPromptOverheadTokens, 256);
  assert.equal(report.tokens.after.fixedPromptOverheadTokens, 256);
  assert.equal(
    report.tokens.actualReductionTokens,
    expectedBefore.totalTokens - expectedAfter.totalTokens
  );
  assert.equal(
    report.tokens.potentialReductionUpperBound,
    value.executionResult.potentialReductionUpperBound
  );
  assert.equal(report.runtime.contextGeneration, 21);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.tokens.before));
  assert.equal(value.context.messages, committedMessages);
  assert.deepEqual(value.calls, { transform: 1, semantic: 1 });
});

test("removed units become inactive and replacements retain stable IDs", async () => {
  const value = await pipeline();
  const report = finalize(value);
  const removed = value.contextInventory.get("cu_finalize_000002");
  const externalized = value.contextInventory.get("cu_finalize_000003");
  const compressedUnit = value.contextInventory.get("cu_finalize_000004");

  assert.equal(report.status, "FINALIZED");
  assert.notEqual(removed.lifecycle, "ACTIVE");
  assert.equal(externalized.id, "cu_finalize_000003");
  assert.equal(compressedUnit.id, "cu_finalize_000004");
  assert.equal(compressedUnit.content, compressed);
  assert.equal(report.inventoryAfter.fingerprint, value.contextInventory.snapshot().inventory.fingerprint);
});

test("actual reduction remains signed when a canonical marker expands context", async () => {
  const value = await pipeline({ negative: true });
  const report = finalize(value);

  assert.equal(report.status, "FINALIZED");
  assert.ok(report.tokens.after.totalTokens > report.tokens.before.totalTokens);
  assert.ok(report.tokens.actualReductionTokens < 0);
  assert.equal(
    report.tokens.actualReductionTokens,
    report.tokens.before.totalTokens - report.tokens.after.totalTokens
  );
  assert.deepEqual(value.calls, { transform: 0, semantic: 0 });
});

test("post-commit generation drift blocks accounting without undoing D5", async () => {
  const value = await pipeline();
  const afterD5 = value.context.messages;
  const concurrent = [...afterD5, { role: "user", content: "new work after commit" }];
  value.context.messages = concurrent;
  value.context.contextGeneration += 1;

  const failure = finalize(value);

  assert.equal(failure.status, "EXECUTION_FINALIZATION_FAILED");
  assert.equal(failure.executionCommitted, true);
  assert.deepEqual(failure.reasonCodes, ["FINALIZATION_STALE_CONTEXT"]);
  assert.equal(failure.actualReductionTokens, null);
  assert.equal(value.context.messages, concurrent);
  assert.notEqual(value.context.messages, value.messagesBefore);
});

test("accounting identity drift fails without rolling back the committed context", async () => {
  const value = await pipeline();
  const afterD5 = value.context.messages;
  const changedTools = [...value.tools, {
    type: "function",
    function: { name: "write_file", description: "write", parameters: { type: "object" } }
  }];

  const failure = finalize(value, { tools: changedTools });

  assert.deepEqual(failure.reasonCodes, ["ACCOUNTING_IDENTITY_MISMATCH"]);
  assert.equal(failure.executionCommitted, true);
  assert.equal(failure.actualReductionTokens, null);
  assert.equal(value.context.messages, afterD5);
  assert.deepEqual(value.contextInventory.snapshot().inventory, value.executionResult.inventoryBefore);
});

test("rebuild and measurement failures never become EXECUTION_ABORTED or roll back D5", async (t) => {
  await t.test("inventory rebuild failure", async () => {
    const value = await pipeline();
    const afterD5 = value.context.messages;
    value.contextInventory.synchronize = () => { throw new Error("rebuild failed"); };
    const failure = finalize(value);

    assert.equal(failure.status, "EXECUTION_FINALIZATION_FAILED");
    assert.deepEqual(failure.reasonCodes, ["INVENTORY_REBUILD_FAILED"]);
    assert.equal(failure.executionCommitted, true);
    assert.equal(value.context.messages, afterD5);
  });

  await t.test("token measurement failure", async () => {
    const value = await pipeline();
    const afterD5 = value.context.messages;
    value.contextManager.estimateComponents = () => { throw new Error("measurement failed"); };
    const failure = finalize(value);

    assert.equal(failure.status, "EXECUTION_FINALIZATION_FAILED");
    assert.deepEqual(failure.reasonCodes, ["TOKEN_ACCOUNTING_FAILED"]);
    assert.equal(failure.executionCommitted, true);
    assert.equal(failure.actualReductionTokens, null);
    assert.equal(value.context.messages, afterD5);
  });
});

test("D6 rejects a non-committed execution result without mutation or measurement", async () => {
  const value = await pipeline();
  const invalid = structuredClone(value.executionResult);
  invalid.status = "EXECUTION_ABORTED";
  invalid.committed = false;
  const afterD5 = value.context.messages;

  const failure = finalize(value, { executionResult: invalid });

  assert.deepEqual(failure.reasonCodes, ["INVALID_EXECUTION_RESULT"]);
  assert.equal(failure.executionCommitted, false);
  assert.equal(value.context.messages, afterD5);
});
