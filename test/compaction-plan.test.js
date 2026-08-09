import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPACTION_ACTIONS,
  CompactionPlanError,
  expandPlanDefaults,
  parseCompactionPlan,
  validatePlanBinding
} from "../src/compaction-plan.js";
import { ContextInventory, fingerprintContextUnits } from "../src/context-inventory.js";
import { FakePlanner } from "../src/planners/fake-planner.js";
import { assertContextPlanner } from "../src/planners/planner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryFixture = readJson(path.join(root, "test", "fixtures", "inventories", "basic.json"));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function planFixture(name) {
  return readJson(path.join(root, "test", "fixtures", "plans", name));
}

function fixtureInventory() {
  const inventory = new ContextInventory({ sessionId: inventoryFixture.sessionId });
  for (const unit of inventoryFixture.units) inventory.register(unit);
  return inventory;
}

function assertPlanError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof CompactionPlanError);
    assert.equal(error.code, code);
    return true;
  });
}

test("inventory snapshot identity is canonical and repeatable", () => {
  const inventory = fixtureInventory();
  const first = inventory.snapshot();
  const second = inventory.snapshot();
  assert.deepEqual(first.inventory, {
    id: "inv_fixture_1561c913550da168",
    fingerprint: "sha256:1561c913550da1682c75a02bc8a52bb7ce1ae2a8a7e6d799840e5f50a45a8159"
  });
  assert.deepEqual(second.inventory, first.inventory);
  assert.deepEqual(first.units.map((unit) => unit.position), [0, 1, 2, 3]);
});

test("inventory fingerprint covers every plan-relevant unit property", async (t) => {
  const mutations = {
    content: (units) => { units[0].content += " changed"; },
    order: (units) => { units.reverse(); },
    lifecycle: (units) => { units[1].lifecycle = "EXTERNALIZED"; },
    authority: (units) => { units[1].authority = "DERIVED"; },
    protection: (units) => { units[1].protectedReasons.push("DEPENDENCY_ROOT"); },
    recoverability: (units) => { units[1].recoverability = "memory"; units[1].recoveryRef = null; },
    dependencies: (units) => { units[3].dependencies = []; },
    tokenCost: (units) => { units[1].tokenCost += 1; },
    source: (units) => { units[1].source.name = "different_tool"; },
    task: (units) => { units[1].taskId = "different-task"; }
  };
  const original = fingerprintContextUnits(inventoryFixture.units);
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const units = structuredClone(inventoryFixture.units);
      mutate(units);
      assert.notEqual(fingerprintContextUnits(units), original);
    });
  }
});

test("valid plan fixtures pass strict parsing and snapshot binding", () => {
  const snapshot = fixtureInventory().snapshot();
  for (const name of [
    "valid-basic.json",
    "valid-externalize.json",
    "valid-compress.json",
    "valid-promote-proposal.json"
  ]) {
    const parsed = validatePlanBinding(planFixture(name), snapshot);
    assert.equal(parsed.schemaVersion, 1);
  }
});

test("unmentioned Context Units default to KEEP", () => {
  const snapshot = fixtureInventory().snapshot();
  const expanded = expandPlanDefaults(planFixture("valid-externalize.json"), snapshot);
  assert.equal(expanded.length, snapshot.units.length);
  assert.equal(expanded.find((decision) => decision.unitId === "cu_fixture_000002").action, "EXTERNALIZE");
  const implicit = expanded.filter((decision) => decision.unitId !== "cu_fixture_000002");
  assert.ok(implicit.every((decision) => decision.action === "KEEP" && decision.implicit === true));
});

test("strict parser rejects malformed JSON and schema drift", () => {
  assertPlanError(() => parseCompactionPlan("{broken"), "MALFORMED_JSON");
  assertPlanError(() => parseCompactionPlan(planFixture("invalid-action.json")), "SCHEMA_VIOLATION");
  assertPlanError(() => parseCompactionPlan(planFixture("invalid-extra-field.json")), "SCHEMA_VIOLATION");
  assertPlanError(() => parseCompactionPlan(planFixture("invalid-negative-target.json")), "SCHEMA_VIOLATION");
  assertPlanError(() => parseCompactionPlan(planFixture("invalid-duplicate-unit.json")), "DUPLICATE_DECISION");
});

test("plan binding rejects stale snapshots and unknown units", () => {
  const snapshot = fixtureInventory().snapshot();
  assertPlanError(() => validatePlanBinding(planFixture("invalid-stale-inventory.json"), snapshot), "STALE_INVENTORY");
  assertPlanError(() => validatePlanBinding(planFixture("invalid-unknown-unit.json"), snapshot), "UNKNOWN_UNIT");

  const changed = fixtureInventory();
  changed.register({
    id: "cu_fixture_000005",
    kind: "USER_CONTEXT",
    content: "A new turn arrived after planning.",
    source: { type: "message", role: "user" },
    authority: "USER",
    createdAt: "2026-08-09T00:04:00.000Z",
    taskId: "fixture-task",
    recoverability: "none",
    recoveryRef: null,
    protectedReasons: ["LATEST_USER_TURN"],
    dependencies: [],
    tokenCost: 14,
    lifecycle: "ACTIVE"
  });
  assertPlanError(() => validatePlanBinding(planFixture("valid-basic.json"), changed.snapshot()), "STALE_INVENTORY");
});

test("Planner cannot mutate Runtime-owned fields or claim token savings", () => {
  const base = planFixture("valid-basic.json");
  for (const field of [
    "authority",
    "protectedReasons",
    "recoverability",
    "lifecycle",
    "replacement",
    "expectedTokensSaved"
  ]) {
    const plan = structuredClone(base);
    plan.decisions[0][field] = field === "expectedTokensSaved" ? 9000 : "forbidden";
    assertPlanError(() => parseCompactionPlan(plan), "SCHEMA_VIOLATION");
  }
  const topLevelClaim = structuredClone(base);
  topLevelClaim.expectedTokensSaved = 9000;
  assertPlanError(() => parseCompactionPlan(topLevelClaim), "SCHEMA_VIOLATION");
});

test("targetTokens is positive and belongs only to COMPRESS", () => {
  const plan = planFixture("valid-basic.json");
  plan.decisions[0].targetTokens = 10;
  assertPlanError(() => parseCompactionPlan(plan), "SCHEMA_VIOLATION");
});

test("empty decision list is valid and means KEEP everything", () => {
  const snapshot = fixtureInventory().snapshot();
  const plan = planFixture("valid-basic.json");
  plan.planId = "plan_keep_by_default";
  plan.decisions = [];
  const expanded = expandPlanDefaults(plan, snapshot);
  assert.ok(expanded.every((decision) => decision.action === "KEEP" && decision.implicit));
});

test("FakePlanner exercises protocol actions without parsing or execution side effects", async () => {
  const snapshot = fixtureInventory().snapshot();
  const configured = {
    schemaVersion: 1,
    planId: "plan_all_actions",
    inventory: snapshot.inventory,
    decisions: COMPACTION_ACTIONS.map((action, index) => ({
      unitId: `cu_fixture_${String(index + 10).padStart(6, "0")}`,
      action,
      importance: "low",
      reason: `Fixture proposal for ${action}`,
      ...(action === "COMPRESS" ? { targetTokens: 10 } : {})
    }))
  };
  const planner = assertContextPlanner(new FakePlanner({ plan: configured }));
  const input = { inventory: snapshot.inventory, units: snapshot.units };
  const output = await planner.plan(input);
  output.decisions[0].reason = "mutated by caller";
  assert.equal(configured.decisions[0].reason, "Fixture proposal for KEEP");
  assert.equal(planner.calls.length, 1);
  assert.deepEqual(planner.calls[0], input);
});

test("PROMOTE_PROPOSAL remains data only and cannot carry persistent content", () => {
  const plan = parseCompactionPlan(planFixture("valid-promote-proposal.json"));
  assert.equal(plan.decisions[0].action, "PROMOTE_PROPOSAL");
  assert.equal(Object.hasOwn(plan.decisions[0], "target"), false);
  assert.equal(Object.hasOwn(plan.decisions[0], "content"), false);
  assert.equal(Object.hasOwn(plan.decisions[0], "authority"), false);
});
