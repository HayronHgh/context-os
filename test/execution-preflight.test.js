import assert from "node:assert/strict";
import test from "node:test";
import { ContextInventory } from "../src/context-inventory.js";
import { validateCompactionAuthorization } from "../src/compaction-validator.js";
import { preflightValidatedPlan } from "../src/execution-preflight.js";
import { RecoveryVerifier } from "../src/recovery-verifier.js";

const fixedNow = () => new Date("2026-08-10T02:00:00.000Z");

function unit({
  id,
  authority = "DERIVED",
  recoverability = "none",
  recoveryRef = null,
  protectedReasons = [],
  tokenCost = 100
}) {
  return {
    id,
    kind: authority === "EVIDENCE" ? "TOOL_EVIDENCE" : "USER_CONTEXT",
    content: `${id} execution fixture`,
    source: { type: "fixture" },
    authority,
    createdAt: "2026-08-10T00:00:00.000Z",
    taskId: "execution-task",
    recoverability,
    recoveryRef,
    protectedReasons,
    dependencies: [],
    tokenCost,
    lifecycle: "ACTIVE"
  };
}

function snapshot() {
  const inventory = new ContextInventory({ sessionId: "execution" });
  inventory.register(unit({
    id: "cu_execution_000001",
    authority: "USER",
    protectedReasons: ["EXPLICIT_USER_CONSTRAINT"],
    tokenCost: 100
  }));
  inventory.register(unit({
    id: "cu_execution_000002",
    authority: "EVIDENCE",
    recoverability: "artifact",
    recoveryRef: { artifactId: "artifact-execution-1", sha256: "a".repeat(64) },
    tokenCost: 600
  }));
  inventory.register(unit({
    id: "cu_execution_000003",
    authority: "DERIVED",
    tokenCost: 300
  }));
  return inventory.snapshot();
}

function planFor(inventory, decisions) {
  return {
    schemaVersion: 1,
    planId: "plan_execution_preflight",
    inventory: structuredClone(inventory.inventory),
    decisions: decisions.map((decision) => ({
      importance: "low",
      reason: "Execution preflight fixture",
      ...decision
    }))
  };
}

function validated(inventory, requiredReductionTokens = 700) {
  return validateCompactionAuthorization({
    plan: planFor(inventory, [
      { unitId: "cu_execution_000002", action: "EVICT" },
      { unitId: "cu_execution_000003", action: "COMPRESS", targetTokens: 100 }
    ]),
    inventory,
    pressure: { requiredReductionTokens }
  });
}

function verifier({ artifactVerified = true, calls = [] } = {}) {
  return new RecoveryVerifier({
    providers: {
      artifact: async ({ recoveryRef }) => {
        calls.push(structuredClone(recoveryRef));
        return artifactVerified
          ? { verified: true, evidence: { artifactId: recoveryRef.artifactId, sha256: recoveryRef.sha256 } }
          : { verified: false, code: "RECOVERY_SOURCE_NOT_FOUND", detail: "artifact missing" };
      }
    },
    now: fixedNow
  });
}

test("ExecutionPreflight emits a distinct immutable ExecutablePlan with zero mutation", async () => {
  const inventory = snapshot();
  const authorized = validated(inventory);
  assert.equal(authorized.status, "AUTHORIZED_POTENTIALLY_SUFFICIENT");
  const before = structuredClone({ inventory, authorized });
  const calls = [];
  const executable = await preflightValidatedPlan({
    validatedPlan: authorized,
    inventory,
    recoveryVerifier: verifier({ calls }),
    now: fixedNow
  });

  assert.equal(executable.status, "EXECUTABLE");
  assert.equal(executable.executablePlanId, "exec_execution_preflight");
  assert.equal(executable.sourceValidatedPlanId, authorized.planId);
  assert.equal(executable.runtime.zeroMutation, true);
  assert.equal(executable.runtime.actualReductionTokens, null);
  assert.equal(calls.length, 1);
  assert.equal(executable.decisions.find((entry) => entry.unitId === "cu_execution_000001").executionDisposition, "NOOP");
  assert.equal(executable.decisions.find((entry) => entry.unitId === "cu_execution_000002").recoveryProof.status, "VERIFIED");
  assert.equal(executable.decisions.find((entry) => entry.unitId === "cu_execution_000003").recoveryProof.status, "NOT_REQUIRED");
  assert.equal(JSON.stringify(executable).includes("replacementContent"), false);
  assert.ok(Object.isFrozen(executable));
  assert.ok(Object.isFrozen(executable.decisions[0]));
  assert.deepEqual({ inventory, authorized }, before);
});

test("stale inventory fails before any recovery provider call", async () => {
  const inventory = snapshot();
  const authorized = validated(inventory);
  const stale = structuredClone(inventory);
  stale.inventory.fingerprint = `sha256:${"0".repeat(64)}`;
  const calls = [];
  const result = await preflightValidatedPlan({
    validatedPlan: authorized,
    inventory: stale,
    recoveryVerifier: verifier({ calls }),
    now: fixedNow
  });
  assert.equal(result.status, "EXECUTION_PRECONDITION_FAILED");
  assert.deepEqual(result.reasonCodes, ["STALE_INVENTORY"]);
  assert.equal(result.executablePlan, null);
  assert.equal(calls.length, 0);
});

test("insufficient or rejected ValidatedPlan never becomes executable", async () => {
  const inventory = snapshot();
  const calls = [];
  const insufficient = await preflightValidatedPlan({
    validatedPlan: validated(inventory, 801),
    inventory,
    recoveryVerifier: verifier({ calls }),
    now: fixedNow
  });
  assert.deepEqual(insufficient.reasonCodes, [
    "VALIDATED_PLAN_NOT_EXECUTABLE",
    "FALLBACK_REQUIRED"
  ]);

  const rejectedPlan = validateCompactionAuthorization({
    plan: planFor(inventory, [{ unitId: "cu_execution_000001", action: "EVICT" }]),
    inventory,
    pressure: { requiredReductionTokens: 0 }
  });
  const rejected = await preflightValidatedPlan({
    validatedPlan: rejectedPlan,
    inventory,
    recoveryVerifier: verifier({ calls }),
    now: fixedNow
  });
  assert.ok(rejected.reasonCodes.includes("VALIDATED_PLAN_NOT_EXECUTABLE"));
  assert.ok(rejected.reasonCodes.includes("FALLBACK_REQUIRED"));
  assert.ok(rejected.reasonCodes.includes("UNAUTHORIZED_DECISION"));
  assert.equal(calls.length, 0);
});

test("failed current-source proof aborts the complete plan", async () => {
  const inventory = snapshot();
  const result = await preflightValidatedPlan({
    validatedPlan: validated(inventory),
    inventory,
    recoveryVerifier: verifier({ artifactVerified: false }),
    now: fixedNow
  });
  assert.equal(result.status, "EXECUTION_PRECONDITION_FAILED");
  assert.deepEqual(result.reasonCodes, ["RECOVERY_SOURCE_NOT_FOUND"]);
  assert.equal(result.executablePlan, null);
  assert.equal(result.checks.find((entry) => entry.unitId === "cu_execution_000002").recoveryProof.status, "FAILED");
});

test("audit-only promotion remains non-executable in ExecutablePlan", async () => {
  const inventory = snapshot();
  const auditPlan = validateCompactionAuthorization({
    plan: planFor(inventory, [{
      unitId: "cu_execution_000003",
      action: "PROMOTE_PROPOSAL"
    }]),
    inventory,
    pressure: { requiredReductionTokens: 0 }
  });
  const executable = await preflightValidatedPlan({
    validatedPlan: auditPlan,
    inventory,
    recoveryVerifier: verifier(),
    now: fixedNow
  });
  const promotion = executable.decisions.find((entry) => entry.unitId === "cu_execution_000003");
  assert.equal(executable.status, "EXECUTABLE");
  assert.equal(promotion.action, "PROMOTE_PROPOSAL");
  assert.equal(promotion.executionDisposition, "AUDIT_ONLY");
  assert.equal(promotion.recoveryProof.status, "NOT_REQUIRED");
});

test("strict ValidatedPlan shape and inventory coverage fail closed", async () => {
  const inventory = snapshot();
  const valid = validated(inventory);
  const forged = { ...structuredClone(valid), mutationAuthority: true };
  const invalidShape = await preflightValidatedPlan({
    validatedPlan: forged,
    inventory,
    recoveryVerifier: verifier(),
    now: fixedNow
  });
  assert.deepEqual(invalidShape.reasonCodes, ["INVALID_VALIDATED_PLAN"]);

  const incomplete = structuredClone(valid);
  incomplete.decisions.shift();
  const mismatch = await preflightValidatedPlan({
    validatedPlan: incomplete,
    inventory,
    recoveryVerifier: verifier(),
    now: fixedNow
  });
  assert.deepEqual(mismatch.reasonCodes, ["INVENTORY_DECISION_MISMATCH"]);

  const malformedInventory = structuredClone(inventory);
  delete malformedInventory.units[0].tokens;
  const invalidInventory = await preflightValidatedPlan({
    validatedPlan: valid,
    inventory: malformedInventory,
    recoveryVerifier: verifier(),
    now: fixedNow
  });
  assert.deepEqual(invalidInventory.reasonCodes, ["INVALID_CURRENT_INVENTORY"]);
});
