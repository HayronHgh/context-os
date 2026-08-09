import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextInventory } from "../src/context-inventory.js";
import {
  buildPlannerInput,
  estimatePlannerRequestTokens,
  normalizePlannerConfig
} from "../src/planners/planner-input.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, "test", "fixtures", "planner", "inventory-units.json"),
  "utf8"
));

function snapshot(units = fixture.units) {
  const inventory = new ContextInventory({ sessionId: fixture.sessionId });
  for (const unit of units) inventory.register(unit);
  return inventory.snapshot({ includeContent: true });
}

const pressure = { ratio: 0.74, requiredReductionTokens: 2000 };
const task = { objective: "Diagnose and fix the refresh race", phase: "investigation" };

test("PlannerInventoryView is bounded globally and per unit", () => {
  const units = structuredClone(fixture.units);
  units[2].content = `head conclusion ${"middle ".repeat(400)}tail: refresh transaction is non-atomic`;
  const config = {
    maxInputTokens: 1500,
    maxOutputTokens: 512,
    maxVisibleUnits: 4,
    fullUnitChars: 100,
    maxUnitChars: 240,
    maxTaskChars: 200,
    temperature: 0.1,
    maxAttempts: 2
  };
  const input = buildPlannerInput(snapshot(units), { pressure, task, config });
  assert.ok(input.visibleUnitIds.length <= config.maxVisibleUnits);
  assert.ok(input.hiddenUnitIds.length > 0);
  assert.ok(estimatePlannerRequestTokens(input, { retry: true }) <= config.maxInputTokens);
  assert.ok(input.payload.units.every((unit) => unit.representation.visibleChars <= config.maxUnitChars));
  const evidence = input.payload.units.find((unit) => unit.id === "cu_planner_000003");
  assert.equal(evidence.representation.mode, "summary");
  assert.match(evidence.representation.text, /head conclusion/);
  assert.match(evidence.representation.text, /non-atomic/);
  assert.ok(evidence.representation.text.length < units[2].content.length / 10);
  assert.match(evidence.representation.text, /middle omitted/);
});

test("deterministic selection prioritizes protected, USER, and dependency-root units", () => {
  const config = {
    maxInputTokens: 4000,
    maxVisibleUnits: 3,
    maxUnitChars: 300,
    fullUnitChars: 200
  };
  const first = buildPlannerInput(snapshot(), { pressure, task, config });
  const second = buildPlannerInput(snapshot(), { pressure, task, config });
  assert.deepEqual(first, second);
  assert.deepEqual(first.visibleUnitIds, [
    "cu_planner_000001",
    "cu_planner_000002",
    "cu_planner_000003"
  ]);
  assert.deepEqual(first.hiddenUnitIds, [
    "cu_planner_000004",
    "cu_planner_000005",
    "cu_planner_000006"
  ]);
});

test("Planner input contains Runtime facts but never the raw transcript container", () => {
  const input = buildPlannerInput(snapshot(), { pressure, task });
  assert.deepEqual(input.payload.pressure, pressure);
  assert.equal(input.payload.stats.totalUnits, fixture.units.length);
  assert.equal(Object.hasOwn(input.payload, "messages"), false);
  assert.equal(Object.hasOwn(input.payload, "transcript"), false);
  assert.ok(input.payload.units.every((unit) => {
    return typeof unit.authority === "string"
      && typeof unit.recoverability === "string"
      && typeof unit.protected === "boolean"
      && Number.isSafeInteger(unit.tokens);
  }));
});

test("invalid Planner budgets fail before any model call", () => {
  assert.throws(() => normalizePlannerConfig({ maxAttempts: 3 }), /maxAttempts/);
  assert.throws(() => normalizePlannerConfig({ fullUnitChars: 1001, maxUnitChars: 1000 }), /fullUnitChars/);
  assert.throws(() => buildPlannerInput(snapshot(), {
    pressure,
    task: { objective: "x".repeat(10000), phase: "x" },
    config: { maxInputTokens: 1024, maxTaskChars: 10000 }
  }), /metadata exceeds|maxInputTokens/);
});
