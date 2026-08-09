import assert from "node:assert/strict";
import test from "node:test";
import { validateCompactionAuthorization } from "../src/compaction-validator.js";
import { ContextInventory } from "../src/context-inventory.js";
import { prepareTransformation } from "../src/context-transformer.js";
import { preflightValidatedPlan } from "../src/execution-preflight.js";
import { RecoveryVerifier } from "../src/recovery-verifier.js";
import { contentDigest, externalizedRecoveryMarker } from "../src/transformation-candidate.js";
import { estimateTokens } from "../src/utils.js";

const fixedNow = () => new Date("2026-08-10T04:00:00.000Z");

function unit({ id, authority, recoverability = "none", recoveryRef = null, tokenCost, content }) {
  return {
    id,
    kind: authority === "EVIDENCE" ? "TOOL_EVIDENCE" : "USER_CONTEXT",
    content,
    source: { type: "fixture" },
    authority,
    createdAt: "2026-08-10T00:00:00.000Z",
    taskId: "transformation-task",
    recoverability,
    recoveryRef,
    protectedReasons: authority === "USER" ? ["EXPLICIT_USER_CONSTRAINT"] : [],
    dependencies: [],
    tokenCost,
    lifecycle: "ACTIVE"
  };
}

function currentInventory() {
  const inventory = new ContextInventory({ sessionId: "transform" });
  inventory.register(unit({
    id: "cu_transform_000001",
    authority: "USER",
    tokenCost: 120,
    content: "Keep this user requirement exactly."
  }));
  inventory.register(unit({
    id: "cu_transform_000002",
    authority: "EVIDENCE",
    recoverability: "artifact",
    recoveryRef: { artifactId: "artifact-transform-1", sha256: "a".repeat(64) },
    tokenCost: 600,
    content: "Durable artifact-backed evidence to remove from active context."
  }));
  inventory.register(unit({
    id: "cu_transform_000003",
    authority: "SOURCE_OF_TRUTH",
    recoverability: "repository",
    recoveryRef: { path: "src/example.js", sha256: "b".repeat(64) },
    tokenCost: 500,
    content: "Repository source that will become a deterministic recovery marker."
  }));
  inventory.register(unit({
    id: "cu_transform_000004",
    authority: "DERIVED",
    tokenCost: 300,
    content: "Verbose derived analysis that Qwen may compress into a candidate."
  }));
  inventory.register(unit({
    id: "cu_transform_000005",
    authority: "DERIVED",
    tokenCost: 80,
    content: "Promotion proposal remains audit only."
  }));
  return inventory.snapshot({ includeContent: true });
}

function proposal(inventory) {
  return {
    schemaVersion: 1,
    planId: "plan_transformation_candidate",
    inventory: structuredClone(inventory.inventory),
    decisions: [
      { unitId: "cu_transform_000002", action: "EVICT", importance: "low", reason: "durable" },
      { unitId: "cu_transform_000003", action: "EXTERNALIZE", importance: "medium", reason: "repository" },
      { unitId: "cu_transform_000004", action: "COMPRESS", targetTokens: 100, importance: "low", reason: "verbose" },
      { unitId: "cu_transform_000005", action: "PROMOTE_PROPOSAL", importance: "medium", reason: "audit" }
    ]
  };
}

async function executable(inventory = currentInventory()) {
  const validatedPlan = validateCompactionAuthorization({
    plan: proposal(inventory),
    inventory,
    pressure: { requiredReductionTokens: 1000 }
  });
  const recoveryVerifier = new RecoveryVerifier({
    providers: {
      artifact: async ({ recoveryRef }) => ({
        verified: true,
        evidence: { artifactId: recoveryRef.artifactId, sha256: recoveryRef.sha256 }
      }),
      repository: async ({ recoveryRef }) => ({
        verified: true,
        evidence: { path: recoveryRef.path, sha256: recoveryRef.sha256 }
      })
    },
    now: fixedNow
  });
  return preflightValidatedPlan({ validatedPlan, inventory, recoveryVerifier, now: fixedNow });
}

class FakeTransformer {
  constructor({ content = "Compressed derived candidate.", error = null } = {}) {
    this.content = content;
    this.error = error;
    this.calls = [];
  }

  async compress(input) {
    this.calls.push(structuredClone(input));
    if (this.error) throw this.error;
    return this.content;
  }
}

test("ExecutablePlan becomes one immutable zero-mutation candidate per decision", async () => {
  const inventory = currentInventory();
  const executablePlan = await executable(inventory);
  const before = structuredClone({ inventory, executablePlan });
  const transformer = new FakeTransformer();
  const candidate = await prepareTransformation({ executablePlan, inventory, transformer, now: fixedNow });

  assert.equal(candidate.status, "PREPARED");
  assert.equal(candidate.candidateId, "candidate_transformation_candidate");
  assert.equal(candidate.sourceExecutablePlanId, executablePlan.executablePlanId);
  assert.deepEqual(candidate.inventory, inventory.inventory);
  assert.equal(candidate.decisions.length, executablePlan.decisions.length);
  assert.equal(new Set(candidate.decisions.map((entry) => entry.unitId)).size, executablePlan.decisions.length);
  assert.equal(candidate.runtime.zeroMutation, true);
  assert.equal(candidate.runtime.actualReductionTokens, null);
  assert.ok(Object.isFrozen(candidate));
  assert.ok(Object.isFrozen(candidate.decisions[0]));
  assert.deepEqual({ inventory, executablePlan }, before);
});

test("actions map deterministically and only COMPRESS invokes the transformer", async () => {
  const inventory = currentInventory();
  const executablePlan = await executable(inventory);
  const transformer = new FakeTransformer({ content: "oversize candidate ".repeat(40) });
  const candidate = await prepareTransformation({ executablePlan, inventory, transformer, now: fixedNow });
  const byId = new Map(candidate.decisions.map((entry) => [entry.unitId, entry]));

  assert.equal(byId.get("cu_transform_000001").operation, "NOOP");
  assert.equal(byId.get("cu_transform_000002").operation, "REMOVE");
  assert.equal(byId.get("cu_transform_000002").candidateEstimatedTokens, 0);
  assert.equal(byId.get("cu_transform_000003").operation, "REPLACE");
  assert.equal(byId.get("cu_transform_000004").operation, "REPLACE");
  assert.ok(byId.get("cu_transform_000004").candidateEstimatedTokens > 100);
  assert.equal(byId.get("cu_transform_000005").operation, "AUDIT_ONLY");
  assert.equal(transformer.calls.length, 1);
  assert.deepEqual(Object.keys(transformer.calls[0]), [
    "schemaVersion",
    "unitId",
    "kind",
    "authority",
    "targetTokens",
    "content"
  ]);
  assert.equal(transformer.calls[0].unitId, "cu_transform_000004");
  assert.equal(Object.hasOwn(transformer.calls[0], "recoverability"), false);
  assert.equal(Object.hasOwn(transformer.calls[0], "recoveryProof"), false);
});

test("Runtime computes source/candidate digests, estimates, and canonical recovery marker", async () => {
  const inventory = currentInventory();
  const executablePlan = await executable(inventory);
  const transformed = "Runtime hashes this model candidate.";
  const candidate = await prepareTransformation({
    executablePlan,
    inventory,
    transformer: new FakeTransformer({ content: transformed }),
    now: fixedNow
  });
  const compressed = candidate.decisions.find((entry) => entry.action === "COMPRESS");
  const externalized = candidate.decisions.find((entry) => entry.action === "EXTERNALIZE");
  const source = inventory.units.find((unit) => unit.id === compressed.unitId);
  const externalizedUnit = inventory.units.find((unit) => unit.id === externalized.unitId);
  const executableDecision = executablePlan.decisions.find((entry) => entry.unitId === externalized.unitId);

  assert.equal(compressed.sourceContentDigest, contentDigest(source.content));
  assert.equal(compressed.candidateContentDigest, contentDigest(transformed));
  assert.equal(compressed.candidateEstimatedTokens, estimateTokens(transformed));
  assert.equal(externalized.candidateContent, externalizedRecoveryMarker({
    unit: externalizedUnit,
    recoveryProof: executableDecision.recoveryProof
  }));
  assert.equal(externalized.candidateContentDigest, contentDigest(externalized.candidateContent));
});

test("stale or incomplete inventory fails before any model call", async () => {
  const inventory = currentInventory();
  const executablePlan = await executable(inventory);
  const transformer = new FakeTransformer();
  const stale = structuredClone(inventory);
  stale.inventory.fingerprint = `sha256:${"0".repeat(64)}`;
  const staleResult = await prepareTransformation({ executablePlan, inventory: stale, transformer, now: fixedNow });
  assert.equal(staleResult.status, "TRANSFORMATION_STALE_INVENTORY");
  assert.equal(staleResult.candidate, null);
  assert.equal(transformer.calls.length, 0);

  const noContent = structuredClone(inventory);
  delete noContent.units[0].content;
  const invalid = await prepareTransformation({ executablePlan, inventory: noContent, transformer, now: fixedNow });
  assert.equal(invalid.status, "TRANSFORMATION_FAILED");
  assert.deepEqual(invalid.reasonCodes, ["TRANSFORMATION_INVENTORY_MISMATCH"]);
  assert.equal(transformer.calls.length, 0);

  const mismatchedProof = structuredClone(executablePlan);
  mismatchedProof.decisions.find((entry) => entry.unitId === "cu_transform_000004")
    .recoveryProof.sourceType = "artifact";
  const mismatch = await prepareTransformation({
    executablePlan: mismatchedProof,
    inventory,
    transformer,
    now: fixedNow
  });
  assert.deepEqual(mismatch.reasonCodes, ["EXECUTABLE_PLAN_SOURCE_MISMATCH"]);
  assert.equal(transformer.calls.length, 0);
});

test("one generation error fails the whole plan without a partial candidate", async () => {
  const inventory = currentInventory();
  const executablePlan = await executable(inventory);
  const transformer = new FakeTransformer({ error: new Error("model unavailable") });
  const result = await prepareTransformation({ executablePlan, inventory, transformer, now: fixedNow });
  assert.equal(result.status, "TRANSFORMATION_FAILED");
  assert.equal(result.candidate, null);
  assert.deepEqual(result.reasonCodes, ["TRANSFORMER_FAILED"]);
  assert.equal(result.runtime.zeroMutation, true);
  assert.equal(result.runtime.actualReductionTokens, null);
});

test("preparation leaves the source message container unchanged", async () => {
  const messages = [
    { role: "system", content: "System boundary" },
    { role: "user", content: "Current requirement" },
    { role: "assistant", content: "Current working answer" }
  ];
  const inventoryRuntime = new ContextInventory({ sessionId: "messageguard" });
  inventoryRuntime.synchronize(messages);
  const inventory = inventoryRuntime.snapshot({ includeContent: true });
  const validatedPlan = validateCompactionAuthorization({
    plan: {
      schemaVersion: 1,
      planId: "plan_message_container_guard",
      inventory: structuredClone(inventory.inventory),
      decisions: []
    },
    inventory,
    pressure: { requiredReductionTokens: 0 }
  });
  const executablePlan = await preflightValidatedPlan({
    validatedPlan,
    inventory,
    recoveryVerifier: new RecoveryVerifier({ now: fixedNow }),
    now: fixedNow
  });
  const before = structuredClone(messages);
  const candidate = await prepareTransformation({ executablePlan, inventory, now: fixedNow });
  assert.equal(candidate.status, "PREPARED");
  assert.deepEqual(messages, before);
});
