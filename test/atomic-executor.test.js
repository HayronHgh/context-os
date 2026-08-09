import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/agent-runtime.js";
import { AtomicExecutor } from "../src/atomic-executor.js";
import { validateCompactionAuthorization } from "../src/compaction-validator.js";
import { ContextInventory } from "../src/context-inventory.js";
import { ContextManager } from "../src/context-manager.js";
import { prepareTransformation } from "../src/context-transformer.js";
import { preflightValidatedPlan } from "../src/execution-preflight.js";
import { validateTransformation } from "../src/post-transform-validator.js";
import { RecoveryVerifier } from "../src/recovery-verifier.js";

const fixedNow = () => new Date("2026-08-10T08:00:00.000Z");
const sourceToCompress = "Constraint ALPHA remains. Identifier API_42 and path src/core.js are required. Error E_FAIL is unresolved. ".repeat(30);
const acceptedCompression = "Keep constraint ALPHA, identifier API_42, path src/core.js, and unresolved error E_FAIL.";
const accountingTools = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read one file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
}];
const contextConfig = {
  contextWindow: 32768,
  reservedOutputTokens: 4096,
  fixedPromptOverheadTokens: 512,
  maxToolOutputChars: 12000,
  thresholds: { garbageCollect: 0.55, prune: 0.65, semanticCompact: 0.72, hardTransfer: 0.8, failure: 0.9 }
};

function descriptor({ id, kind, authority, recoverability = "none", recoveryRef = null }) {
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

function sourceMessages() {
  return [
    { role: "system", content: "Runtime rules remain outside the Context Inventory." },
    {
      role: "user",
      content: "Keep this requirement.",
      context_os: descriptor({
        id: "cu_atomic_000001",
        kind: "USER_CONTEXT",
        authority: "USER"
      })
    },
    {
      role: "assistant",
      content: "Durable evidence eligible for eviction.",
      context_os: descriptor({
        id: "cu_atomic_000002",
        kind: "TOOL_EVIDENCE",
        authority: "EVIDENCE",
        recoverability: "artifact",
        recoveryRef: { artifactId: "artifact-atomic-1", sha256: "a".repeat(64) }
      })
    },
    {
      role: "assistant",
      content: "Repository-backed source eligible for externalization.",
      context_os: descriptor({
        id: "cu_atomic_000003",
        kind: "FILE_SNAPSHOT",
        authority: "SOURCE_OF_TRUTH",
        recoverability: "repository",
        recoveryRef: { path: "src/core.js", sha256: "b".repeat(64) }
      })
    },
    {
      role: "assistant",
      content: sourceToCompress,
      context_os: descriptor({
        id: "cu_atomic_000004",
        kind: "REASONING",
        authority: "DERIVED"
      })
    },
    {
      role: "assistant",
      content: "Promotion stays audit-only.",
      context_os: descriptor({
        id: "cu_atomic_000005",
        kind: "DECISION",
        authority: "DERIVED"
      })
    }
  ];
}

function recoveryVerifier(state, { wait = null } = {}) {
  return new RecoveryVerifier({
    providers: {
      artifact: async ({ recoveryRef }) => {
        if (wait) await wait();
        return state.artifact
          ? { verified: true, evidence: { artifactId: recoveryRef.artifactId } }
          : { verified: false, code: "RECOVERY_SOURCE_NOT_FOUND", detail: "artifact disappeared" };
      },
      repository: async ({ recoveryRef }) => state.repository
        ? { verified: true, evidence: { path: recoveryRef.path } }
        : { verified: false, code: "RECOVERY_SOURCE_NOT_FOUND", detail: "repository source disappeared" }
    },
    now: fixedNow
  });
}

async function fixture({ state = { artifact: true, repository: true } } = {}) {
  const messages = sourceMessages();
  const inventoryRuntime = new ContextInventory({ sessionId: "atomic", now: fixedNow });
  inventoryRuntime.synchronize(messages, { taskId: "atomic-task" });
  const inventory = inventoryRuntime.snapshot({ includeContent: true });
  const plan = {
    schemaVersion: 1,
    planId: "plan_atomic_execution",
    inventory: structuredClone(inventory.inventory),
    decisions: [
      { unitId: "cu_atomic_000002", action: "EVICT", importance: "low", reason: "durable" },
      { unitId: "cu_atomic_000003", action: "EXTERNALIZE", importance: "medium", reason: "repository" },
      { unitId: "cu_atomic_000004", action: "COMPRESS", targetTokens: 80, importance: "low", reason: "verbose" },
      { unitId: "cu_atomic_000005", action: "PROMOTE_PROPOSAL", importance: "medium", reason: "audit" }
    ]
  };
  const validatedPlan = validateCompactionAuthorization({
    plan,
    inventory,
    pressure: { requiredReductionTokens: 700 }
  });
  const verifier = recoveryVerifier(state);
  const executablePlan = await preflightValidatedPlan({
    validatedPlan,
    inventory,
    recoveryVerifier: verifier,
    now: fixedNow
  });
  assert.equal(executablePlan.status, "EXECUTABLE");
  const modelCalls = { transformer: 0, validator: 0 };
  const candidate = await prepareTransformation({
    executablePlan,
    inventory,
    transformer: {
      compress: async () => {
        modelCalls.transformer += 1;
        return acceptedCompression;
      }
    },
    now: fixedNow
  });
  const validatedTransformation = await validateTransformation({
    candidate,
    executablePlan,
    inventory,
    semanticValidator: {
      assess: async () => {
        modelCalls.validator += 1;
        return { verdict: "ACCEPT", reasonCodes: [] };
      }
    },
    now: fixedNow
  });
  assert.equal(validatedTransformation.status, "VALIDATED");
  return {
    state,
    inventory,
    executablePlan,
    candidate,
    validatedTransformation,
    verifier,
    contextManager: new ContextManager(contextConfig),
    tools: accountingTools,
    modelCalls,
    context: { messages, contextGeneration: 11 }
  };
}

function inputOf(value, overrides = {}) {
  return {
    validatedTransformation: value.validatedTransformation,
    candidate: value.candidate,
    executablePlan: value.executablePlan,
    inventory: value.inventory,
    context: value.context,
    recoveryVerifier: value.verifier,
    contextManager: value.contextManager,
    tools: value.tools,
    ...overrides
  };
}

function messageById(messages, unitId) {
  return messages.find((message) => message.context_os?.contextUnitId === unitId);
}

test("AgentRuntime message replacement and append advance the D5 context generation", () => {
  const runtime = Object.create(AgentRuntime.prototype);
  runtime.messages = [];
  runtime.contextGeneration = 0;

  runtime.replaceMessages([{ role: "system", content: "rules" }]);
  const firstReference = runtime.messages;
  runtime.appendMessage({ role: "user", content: "work" });

  assert.equal(runtime.contextGeneration, 2);
  assert.notEqual(runtime.messages, firstReference);
  assert.deepEqual(runtime.messages, [
    { role: "system", content: "rules" },
    { role: "user", content: "work" }
  ]);
});

test("D5 atomically commits every exact operation and returns an immutable result", async () => {
  const value = await fixture();
  const executor = new AtomicExecutor({ now: fixedNow });
  const beforeInputs = structuredClone({
    validatedTransformation: value.validatedTransformation,
    candidate: value.candidate,
    executablePlan: value.executablePlan,
    inventory: value.inventory
  });
  const messagesBefore = value.context.messages;
  const noopBefore = structuredClone(messageById(messagesBefore, "cu_atomic_000001"));
  const auditBefore = structuredClone(messageById(messagesBefore, "cu_atomic_000005"));

  const result = await executor.execute(inputOf(value));

  assert.equal(result.status, "COMMITTED");
  assert.equal(result.committed, true);
  assert.equal(result.sourceValidationId, value.validatedTransformation.validationId);
  assert.equal(result.runtime.contextGenerationBefore, 11);
  assert.equal(result.runtime.contextGenerationAfter, 12);
  assert.ok(result.runtime.tokenAccountingBefore.totalTokens > 0);
  assert.ok(result.runtime.tokenAccountingBefore.toolTokens > 0);
  assert.equal(result.runtime.tokenAccountingBefore.fixedPromptOverheadTokens, 512);
  assert.equal(result.potentialReductionUpperBound, value.executablePlan.runtime.potentialReductionUpperBound);
  assert.equal(value.context.contextGeneration, 12);
  assert.notEqual(value.context.messages, messagesBefore);
  assert.deepEqual(messageById(value.context.messages, "cu_atomic_000001"), noopBefore);
  assert.deepEqual(messageById(value.context.messages, "cu_atomic_000005"), auditBefore);
  assert.equal(messageById(value.context.messages, "cu_atomic_000002"), undefined);
  assert.equal(
    messageById(value.context.messages, "cu_atomic_000003").content,
    value.candidate.decisions.find((decision) => decision.unitId === "cu_atomic_000003").candidateContent
  );
  assert.equal(messageById(value.context.messages, "cu_atomic_000004").content, acceptedCompression);
  assert.equal(value.context.messages[0].content, messagesBefore[0].content);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.operations[0]));
  assert.deepEqual({
    validatedTransformation: value.validatedTransformation,
    candidate: value.candidate,
    executablePlan: value.executablePlan,
    inventory: value.inventory
  }, beforeInputs);
  assert.deepEqual(value.modelCalls, { transformer: 1, validator: 1 });
});

test("NOOP and AUDIT_ONLY remain byte-for-byte unchanged while REMOVE and REPLACE are exact", async () => {
  const value = await fixture();
  const before = structuredClone(value.context.messages);
  const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value));

  assert.equal(result.status, "COMMITTED");
  assert.deepEqual(messageById(value.context.messages, "cu_atomic_000001"), messageById(before, "cu_atomic_000001"));
  assert.deepEqual(messageById(value.context.messages, "cu_atomic_000005"), messageById(before, "cu_atomic_000005"));
  for (const unitId of ["cu_atomic_000003", "cu_atomic_000004"]) {
    const candidateDecision = value.candidate.decisions.find((decision) => decision.unitId === unitId);
    assert.equal(messageById(value.context.messages, unitId).content, candidateDecision.candidateContent);
  }
});

test("stale inventory, changed source, and changed candidate all abort before mutation", async (t) => {
  await t.test("stale inventory", async () => {
    const value = await fixture();
    const before = value.context.messages;
    const stale = structuredClone(value.inventory);
    stale.inventory.fingerprint = `sha256:${"f".repeat(64)}`;
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value, { inventory: stale }));
    assert.deepEqual(result.reasonCodes, ["EXECUTION_STALE_CONTEXT"]);
    assert.equal(value.context.messages, before);
  });

  await t.test("changed source", async () => {
    const value = await fixture();
    const before = value.context.messages;
    messageById(value.context.messages, "cu_atomic_000004").content += " changed after D4";
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value));
    assert.ok(result.reasonCodes.includes("SOURCE_CONTENT_CHANGED"));
    assert.equal(value.context.messages, before);
  });

  await t.test("changed candidate", async () => {
    const value = await fixture();
    const before = value.context.messages;
    const changed = structuredClone(value.candidate);
    changed.decisions.find((decision) => decision.unitId === "cu_atomic_000004").candidateContent += " tampered";
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value, { candidate: changed }));
    assert.ok(result.reasonCodes.includes("CANDIDATE_CONTENT_CHANGED"));
    assert.equal(value.context.messages, before);
  });
});

test("one missing recovery source aborts the A/B/C regression without partial mutation", async () => {
  const value = await fixture();
  const beforeReference = value.context.messages;
  const beforeBytes = structuredClone(value.context.messages);
  value.state.artifact = false;

  const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value));

  assert.equal(result.status, "EXECUTION_ABORTED");
  assert.deepEqual(result.reasonCodes, ["RECOVERY_REVALIDATION_FAILED"]);
  assert.equal(result.committed, false);
  assert.equal(value.context.messages, beforeReference);
  assert.deepEqual(value.context.messages, beforeBytes);
  assert.equal(value.context.contextGeneration, 11);
});

test("a validation is single-use and its second execution fails closed", async () => {
  const value = await fixture();
  const executor = new AtomicExecutor({ now: fixedNow });
  const first = await executor.execute(inputOf(value));
  const committedReference = value.context.messages;
  const second = await executor.execute(inputOf(value));

  assert.equal(first.status, "COMMITTED");
  assert.equal(second.status, "EXECUTION_ABORTED");
  assert.deepEqual(second.reasonCodes, ["EXECUTION_ALREADY_CONSUMED"]);
  assert.equal(value.context.messages, committedReference);
  assert.equal(value.context.contextGeneration, 12);
});

test("generation drift during recovery verification aborts the commit", async () => {
  const value = await fixture();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered;
  const providerEntered = new Promise((resolve) => { entered = resolve; });
  const verifier = recoveryVerifier(value.state, {
    wait: async () => {
      entered();
      await blocked;
    }
  });
  const executor = new AtomicExecutor({ now: fixedNow });
  const execution = executor.execute(inputOf(value, { recoveryVerifier: verifier }));
  await providerEntered;
  const concurrentMessages = [...value.context.messages, { role: "assistant", content: "concurrent update" }];
  value.context.messages = concurrentMessages;
  value.context.contextGeneration += 1;
  release();

  const result = await execution;
  assert.deepEqual(result.reasonCodes, ["EXECUTION_STALE_CONTEXT"]);
  assert.equal(value.context.messages, concurrentMessages);
  assert.equal(value.context.contextGeneration, 12);
});

test("build failure cannot expose a partial next context", async () => {
  const value = await fixture();
  const before = value.context.messages;
  value.context.messages[0].context_os = { nonCloneable: () => true };

  const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value));

  assert.deepEqual(result.reasonCodes, ["EXECUTION_BUILD_FAILED"]);
  assert.equal(value.context.messages, before);
  assert.equal(value.context.contextGeneration, 11);
});

test("invalid chain binding and commit failure both fail closed", async (t) => {
  await t.test("invalid validated transformation", async () => {
    const value = await fixture();
    const invalid = structuredClone(value.validatedTransformation);
    invalid.status = "PREPARED";
    const before = value.context.messages;
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value, {
      validatedTransformation: invalid
    }));
    assert.deepEqual(result.reasonCodes, ["INVALID_VALIDATED_TRANSFORMATION"]);
    assert.equal(value.context.messages, before);
  });

  await t.test("chain mismatch", async () => {
    const value = await fixture();
    const wrong = structuredClone(value.candidate);
    wrong.sourceExecutablePlanId = "exec_wrong_chain";
    const before = value.context.messages;
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value, { candidate: wrong }));
    assert.deepEqual(result.reasonCodes, ["EXECUTION_CHAIN_MISMATCH"]);
    assert.equal(value.context.messages, before);
  });

  await t.test("commit failure", async () => {
    const value = await fixture();
    const target = value.context;
    const proxy = new Proxy(target, {
      set(object, property, next) {
        if (property === "messages") throw new Error("commit denied");
        return Reflect.set(object, property, next);
      }
    });
    const before = target.messages;
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value, { context: proxy }));
    assert.deepEqual(result.reasonCodes, ["EXECUTION_COMMIT_FAILED"]);
    assert.equal(target.messages, before);
    assert.equal(target.contextGeneration, 11);
  });

  await t.test("thrown recovery verification", async () => {
    const value = await fixture();
    const before = value.context.messages;
    value.verifier.verify = async () => { throw new Error("provider crashed"); };
    const result = await new AtomicExecutor({ now: fixedNow }).execute(inputOf(value));
    assert.deepEqual(result.reasonCodes, ["RECOVERY_REVALIDATION_FAILED"]);
    assert.equal(value.context.messages, before);
    assert.equal(value.context.contextGeneration, 11);
  });
});
