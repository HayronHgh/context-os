import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextInventory } from "../src/context-inventory.js";
import {
  AUTHORIZATION_POLICY,
  RECOVERABILITY_POLICY,
  computeDependencyClosure,
  isDurablyRecoverable,
  isRecoverable,
  postActionAvailability,
  validateCompactionAuthorization
} from "../src/compaction-validator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, "test", "fixtures", "validation", "runtime-units.json"),
  "utf8"
));

function fixtureSnapshot() {
  return snapshotFrom(fixture.units, fixture.sessionId);
}

function snapshotFrom(units, sessionId = "validation") {
  const inventory = new ContextInventory({ sessionId });
  for (const unit of units) inventory.register(unit);
  return inventory.snapshot();
}

function unitInput({
  id = "cu_policy_000001",
  authority = "DERIVED",
  recoverability = "none",
  protectedReasons = [],
  dependencies = [],
  tokenCost = 100,
  lifecycle = "ACTIVE"
} = {}) {
  return {
    id,
    kind: authority === "EVIDENCE" ? "TOOL_EVIDENCE" : "USER_CONTEXT",
    content: `${authority} ${recoverability} fixture`,
    source: { type: "fixture" },
    authority,
    createdAt: "2026-08-09T01:00:00.000Z",
    taskId: "policy-task",
    recoverability,
    recoveryRef: recoverability === "artifact" ? { artifactId: `${id}-artifact` } : null,
    protectedReasons,
    dependencies,
    tokenCost,
    lifecycle
  };
}

function planFor(snapshot, decisions, planId = "plan_validation") {
  return {
    schemaVersion: 1,
    planId,
    inventory: snapshot.inventory,
    decisions: decisions.map((decision) => ({
      importance: "low",
      reason: "Validation fixture proposal",
      ...decision
    }))
  };
}

function validate(snapshot, decisions, requiredReductionTokens = 0) {
  return validateCompactionAuthorization({
    plan: planFor(snapshot, decisions),
    inventory: snapshot,
    pressure: { requiredReductionTokens }
  });
}

function decision(result, unitId) {
  return result.decisions.find((entry) => entry.unitId === unitId);
}

test("recoverability predicates distinguish durable exact-enough recovery", () => {
  const expected = {
    artifact: [true, true],
    repository: [true, true],
    memory: [true, true],
    rebuildable: [true, false],
    none: [false, false]
  };
  assert.deepEqual(Object.keys(RECOVERABILITY_POLICY), Object.keys(expected));
  for (const [recoverability, [recoverable, durable]] of Object.entries(expected)) {
    const unit = { recoverability };
    assert.equal(isRecoverable(unit), recoverable);
    assert.equal(isDurablyRecoverable(unit), durable);
  }
});

test("protected KEEP is authorized and protected destructive actions are rejected", () => {
  const snapshot = fixtureSnapshot();
  const protectedId = "cu_validation_000001";
  const keep = validate(snapshot, [{ unitId: protectedId, action: "KEEP" }]);
  assert.equal(decision(keep, protectedId).permission, "AUTHORIZED");

  for (const action of ["COMPRESS", "EXTERNALIZE", "EVICT"]) {
    const result = validate(snapshot, [{
      unitId: protectedId,
      action,
      ...(action === "COMPRESS" ? { targetTokens: 50 } : {})
    }]);
    assert.equal(result.status, "REJECTED");
    assert.deepEqual(decision(result, protectedId).reasonCodes, ["PROTECTED_UNIT"]);
  }
});

test("PROMOTE_PROPOSAL is audit-only and never claims reduction", () => {
  const snapshot = fixtureSnapshot();
  const result = validate(snapshot, [{
    unitId: "cu_validation_000001",
    action: "PROMOTE_PROPOSAL"
  }]);
  const promoted = decision(result, "cu_validation_000001");
  assert.equal(promoted.permission, "AUDIT_ONLY");
  assert.deepEqual(promoted.reasonCodes, ["UNSUPPORTED_PROMOTION"]);
  assert.equal(promoted.potentialReductionUpperBound, 0);
  assert.equal(result.runtime.actualReductionTokens, null);
});

test("authority policy is explicit and Planner importance cannot override it", async (t) => {
  assert.deepEqual(Object.keys(AUTHORIZATION_POLICY), [
    "USER", "SOURCE_OF_TRUTH", "EVIDENCE", "DERIVED", "SPECULATIVE"
  ]);
  const cases = [
    ["USER compresses unprotected context", "USER", "none", "COMPRESS", "AUTHORIZED", null],
    ["USER cannot externalize non-recoverable context", "USER", "none", "EXTERNALIZE", "REJECTED", "NON_RECOVERABLE"],
    ["USER can evict recoverable context", "USER", "artifact", "EVICT", "AUTHORIZED", null],
    ["SOURCE_OF_TRUTH externalizes only to repository recovery", "SOURCE_OF_TRUTH", "artifact", "EXTERNALIZE", "REJECTED", "AUTHORITY_VIOLATION"],
    ["SOURCE_OF_TRUTH repository recovery is accepted", "SOURCE_OF_TRUTH", "repository", "EXTERNALIZE", "AUTHORIZED", null],
    ["EVIDENCE can compress durable evidence", "EVIDENCE", "memory", "COMPRESS", "AUTHORIZED", null],
    ["EVIDENCE cannot compress rebuildable evidence", "EVIDENCE", "rebuildable", "COMPRESS", "REJECTED", "NON_RECOVERABLE"],
    ["EVIDENCE can externalize an already recoverable unit", "EVIDENCE", "rebuildable", "EXTERNALIZE", "AUTHORIZED", null],
    ["EVIDENCE cannot evict rebuildable evidence", "EVIDENCE", "rebuildable", "EVICT", "REJECTED", "NON_RECOVERABLE"],
    ["DERIVED can compress non-recoverable context", "DERIVED", "none", "COMPRESS", "AUTHORIZED", null],
    ["DERIVED needs recovery before eviction", "DERIVED", "none", "EVICT", "REJECTED", "NON_RECOVERABLE"],
    ["SPECULATIVE can evict rebuildable context", "SPECULATIVE", "rebuildable", "EVICT", "AUTHORIZED", null]
  ];

  for (const [name, authority, recoverability, action, permission, reasonCode] of cases) {
    await t.test(name, () => {
      const snapshot = snapshotFrom([unitInput({ authority, recoverability })], "policy");
      const result = validate(snapshot, [{
        unitId: "cu_policy_000001",
        action,
        importance: "critical",
        ...(action === "COMPRESS" ? { targetTokens: 40 } : {})
      }]);
      const evaluated = decision(result, "cu_policy_000001");
      assert.equal(evaluated.permission, permission);
      assert.equal(evaluated.importance, "critical");
      if (reasonCode) assert.ok(evaluated.reasonCodes.includes(reasonCode));
    });
  }
});

test("invalid compression targets are protocol-valid but authorization-rejected", () => {
  const snapshot = snapshotFrom([unitInput({ tokenCost: 100 })], "policy");
  for (const targetTokens of [100, 150]) {
    const result = validate(snapshot, [{
      unitId: "cu_policy_000001",
      action: "COMPRESS",
      targetTokens
    }]);
    assert.equal(result.status, "REJECTED");
    assert.deepEqual(decision(result, "cu_policy_000001").reasonCodes, ["INVALID_COMPRESSION_TARGET"]);
  }
});

test("dependency closure is transitive and blocks unavailable required units", () => {
  const units = [
    unitInput({
      id: "cu_graph_000001",
      dependencies: [{ unitId: "cu_graph_000002", relation: "depends_on" }]
    }),
    unitInput({
      id: "cu_graph_000002",
      dependencies: [{ unitId: "cu_graph_000003", relation: "depends_on" }]
    }),
    unitInput({ id: "cu_graph_000003", authority: "SPECULATIVE", recoverability: "none" })
  ];
  const snapshot = snapshotFrom(units, "graph");
  const result = validate(snapshot, [{ unitId: "cu_graph_000003", action: "EVICT" }]);
  const target = decision(result, "cu_graph_000003");
  assert.equal(target.permission, "REJECTED");
  assert.ok(target.reasonCodes.includes("NON_RECOVERABLE"));
  assert.ok(target.reasonCodes.includes("ACTIVE_DEPENDENCY"));

  const graph = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set()]
  ]);
  assert.deepEqual([...computeDependencyClosure(graph).get("a")].sort(), ["b", "c"]);
});

test("a recoverable dependency remains available after eviction", () => {
  const snapshot = fixtureSnapshot();
  const result = validate(snapshot, [{ unitId: "cu_validation_000002", action: "EVICT" }], 500);
  const evidence = decision(result, "cu_validation_000002");
  assert.equal(postActionAvailability(snapshot.units[1], "EVICT"), "RECOVERABLE");
  assert.equal(evidence.permission, "AUTHORIZED");
  assert.equal(evidence.reasonCodes.includes("ACTIVE_DEPENDENCY"), false);
  assert.equal(evidence.replacementCostUnknown, true);
});

test("missing dependency targets reject the whole plan", () => {
  const snapshot = snapshotFrom([unitInput({
    dependencies: [{ unitId: "cu_policy_999999", relation: "depends_on" }]
  })], "policy");
  const result = validate(snapshot, [], 0);
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["MISSING_DEPENDENCY"]);
  assert.equal(result.runtime.fallbackRequired, true);
});

test("dependency cycles reject the whole plan", () => {
  const snapshot = snapshotFrom([
    unitInput({
      id: "cu_cycle_000001",
      dependencies: [{ unitId: "cu_cycle_000002", relation: "depends_on" }]
    }),
    unitInput({
      id: "cu_cycle_000002",
      dependencies: [{ unitId: "cu_cycle_000001", relation: "depends_on" }]
    })
  ], "cycle");
  const result = validate(snapshot, [], 0);
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["DEPENDENCY_CYCLE"]);
});

test("Runtime reports only definite insufficiency or potential sufficiency", () => {
  const snapshot = snapshotFrom([unitInput({ tokenCost: 100 })], "policy");
  const proposed = [{
    unitId: "cu_policy_000001",
    action: "COMPRESS",
    targetTokens: 20
  }];
  const insufficient = validate(snapshot, proposed, 81);
  assert.equal(insufficient.status, "AUTHORIZED_DEFINITELY_INSUFFICIENT");
  assert.equal(insufficient.runtime.potentialReductionUpperBound, 80);
  assert.equal(insufficient.runtime.actualReductionTokens, null);
  assert.equal(insufficient.runtime.fallbackRequired, true);

  const potential = validate(snapshot, proposed, 80);
  assert.equal(potential.status, "AUTHORIZED_POTENTIALLY_SUFFICIENT");
  assert.equal(potential.runtime.potentialReductionUpperBound, 80);
  assert.equal(potential.runtime.actualReductionTokens, null);
  assert.equal(potential.runtime.fallbackRequired, false);
});

test("validation is deterministic and produces no observable side effects", () => {
  const snapshot = fixtureSnapshot();
  const plan = planFor(snapshot, [{
    unitId: "cu_validation_000002",
    action: "EXTERNALIZE"
  }]);
  const pressure = { requiredReductionTokens: 100 };
  const runtimeState = {
    messages: [{ role: "user", content: "Keep this intact" }],
    inventory: snapshot,
    projectMemory: "stable memory",
    episodes: [{ id: "episode-1" }],
    artifacts: [{ id: "artifact-1" }]
  };
  const before = structuredClone({ runtimeState, plan, pressure });
  const first = validateCompactionAuthorization({ plan, inventory: runtimeState.inventory, pressure });
  const second = validateCompactionAuthorization({ plan, inventory: runtimeState.inventory, pressure });
  assert.deepEqual(first, second);
  assert.deepEqual({ runtimeState, plan, pressure }, before);
  assert.equal(first.runtime.actualReductionTokens, null);
});

test("M2 stale snapshot and unknown unit failures remain fail-closed", () => {
  const snapshot = fixtureSnapshot();
  const stale = planFor(snapshot, []);
  stale.inventory = {
    ...stale.inventory,
    fingerprint: `sha256:${"0".repeat(64)}`
  };
  const staleResult = validateCompactionAuthorization({
    plan: stale,
    inventory: snapshot,
    pressure: { requiredReductionTokens: 0 }
  });
  assert.equal(staleResult.status, "REJECTED");
  assert.deepEqual(staleResult.reasonCodes, ["STALE_INVENTORY"]);

  const unknown = planFor(snapshot, [{ unitId: "cu_validation_999999", action: "KEEP" }]);
  const unknownResult = validateCompactionAuthorization({
    plan: unknown,
    inventory: snapshot,
    pressure: { requiredReductionTokens: 0 }
  });
  assert.equal(unknownResult.status, "REJECTED");
  assert.deepEqual(unknownResult.reasonCodes, ["UNKNOWN_UNIT"]);
});

test("invalid Runtime pressure fails closed", () => {
  const snapshot = fixtureSnapshot();
  const result = validateCompactionAuthorization({
    plan: planFor(snapshot, []),
    inventory: snapshot,
    pressure: { requiredReductionTokens: -1 }
  });
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["FAILURE_ENVELOPE_RISK"]);
  assert.equal(result.runtime.requiredReductionTokens, null);
});
