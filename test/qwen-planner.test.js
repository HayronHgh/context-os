import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextInventory } from "../src/context-inventory.js";
import { createPlannerSessionAudit } from "../src/planner-observability.js";
import { buildPlannerInput } from "../src/planners/planner-input.js";
import { PLANNER_PROMPT_VERSION } from "../src/planners/planner-prompt.js";
import { QwenPlanner, SemanticPlannerError } from "../src/planners/qwen-planner.js";
import { generateSemanticProposal } from "../src/semantic-proposal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, "test", "fixtures", "planner", "inventory-units.json"),
  "utf8"
));
const pressure = { ratio: 0.74, requiredReductionTokens: 2000 };
const task = { objective: "Diagnose and fix the refresh race", phase: "investigation" };
const plannerConfig = {
  maxInputTokens: 12000,
  maxOutputTokens: 512,
  maxVisibleUnits: 6,
  fullUnitChars: 600,
  maxUnitChars: 1000,
  maxTaskChars: 1000,
  temperature: 0.1,
  maxAttempts: 2
};

class FakePlannerClient {
  constructor(outputs) {
    this.outputs = [...outputs];
    this.calls = [];
  }

  async chat(messages, options) {
    this.calls.push(structuredClone({ messages, options }));
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return {
      message: {
        content: output,
        reasoning_content: "hidden reasoning must not be audited"
      },
      usage: { prompt_tokens: 700, completion_tokens: 80 }
    };
  }
}

function snapshot(units = fixture.units) {
  const inventory = new ContextInventory({ sessionId: fixture.sessionId });
  for (const unit of units) inventory.register(unit);
  return inventory.snapshot({ includeContent: true });
}

function inputFor(current = snapshot(), config = plannerConfig) {
  return buildPlannerInput(current, { pressure, task, config });
}

function planFor(input, decisions = [], overrides = {}) {
  return {
    schemaVersion: 1,
    planId: input.payload.requestedPlanId,
    inventory: structuredClone(input.payload.inventory),
    decisions: decisions.map((decision) => ({
      importance: "low",
      reason: "Planner fixture proposal",
      ...decision
    })),
    ...overrides
  };
}

function jsonPlan(input, decisions = [], overrides = {}) {
  return JSON.stringify(planFor(input, decisions, overrides));
}

test("QwenPlanner uses an isolated, tool-free, versioned strict-JSON request", async () => {
  const input = inputFor();
  const client = new FakePlannerClient([`\n\`\`\`json\n${jsonPlan(input)}\n\`\`\``]);
  const events = [];
  const planner = new QwenPlanner({ client, config: plannerConfig, audit: (event) => events.push(event) });
  const plan = await planner.plan(input);
  assert.equal(plan.planId, input.payload.requestedPlanId);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].messages.length, 2);
  assert.equal(client.calls[0].messages[0].role, "system");
  assert.match(client.calls[0].messages[0].content, /You propose context actions/);
  assert.deepEqual(client.calls[0].options.tools, []);
  assert.deepEqual(client.calls[0].options.chatTemplateKwargs, { enable_thinking: false });
  assert.deepEqual(client.calls[0].options.responseFormat, { type: "json_object" });
  assert.equal(client.calls[0].options.temperature, 0.1);
  assert.equal(events[0].plannerVersion, PLANNER_PROMPT_VERSION);
  assert.equal(events[0].parseResult, "ok");
  assert.equal(Object.hasOwn(events[0], "reasoning_content"), false);
  assert.doesNotMatch(JSON.stringify(events), /hidden reasoning/);
});

test("protocol failure gets exactly one bounded correction attempt", async () => {
  const input = inputFor();
  const client = new FakePlannerClient(["not-json", jsonPlan(input)]);
  const events = [];
  const planner = new QwenPlanner({ client, config: plannerConfig, audit: (event) => events.push(event) });
  const plan = await planner.plan(input);
  assert.equal(plan.planId, input.payload.requestedPlanId);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].messages.length, 3);
  assert.match(client.calls[1].messages[2].content, /MALFORMED_JSON/);
  assert.doesNotMatch(client.calls[1].messages[2].content, /not-json/);
  assert.deepEqual(events.map((event) => event.parseResult), ["error", "ok"]);
  assert.equal(planner.lastRun.attempts, 2);
  assert.equal(planner.lastRun.parseFailures, 1);
});

test("two invalid outputs fail closed as PLANNER_FAILED", async () => {
  const input = inputFor();
  const client = new FakePlannerClient(["bad-one", "bad-two"]);
  const planner = new QwenPlanner({ client, config: plannerConfig });
  await assert.rejects(() => planner.plan(input), (error) => {
    assert.ok(error instanceof SemanticPlannerError);
    assert.equal(error.code, "PLANNER_FAILED");
    assert.equal(error.causeCode, "MALFORMED_JSON");
    assert.equal(error.attempts, 2);
    return true;
  });
  assert.equal(client.calls.length, 2);
});

test("non-visible unit decisions may repair once", async () => {
  const input = inputFor(snapshot(), { ...plannerConfig, maxVisibleUnits: 2 });
  const hiddenId = input.hiddenUnitIds[0];
  const client = new FakePlannerClient([
    jsonPlan(input, [{ unitId: hiddenId, action: "KEEP" }]),
    jsonPlan(input)
  ]);
  const planner = new QwenPlanner({ client, config: { ...plannerConfig, maxVisibleUnits: 2 } });
  const plan = await planner.plan(input);
  assert.equal(plan.decisions.length, 0);
  assert.equal(client.calls.length, 2);
  assert.equal(planner.lastRun.parseFailures, 1);
});

test("stale inventory identity is discarded without retry", async () => {
  const input = inputFor();
  const stalePlan = planFor(input);
  stalePlan.inventory.fingerprint = `sha256:${"0".repeat(64)}`;
  const client = new FakePlannerClient([JSON.stringify(stalePlan), jsonPlan(input)]);
  const planner = new QwenPlanner({ client, config: plannerConfig });
  await assert.rejects(() => planner.plan(input), (error) => {
    assert.equal(error.code, "STALE_INVENTORY");
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(client.calls.length, 1);
});

test("client failure may retry once without widening authority", async () => {
  const input = inputFor();
  const client = new FakePlannerClient([new Error("temporary transport failure"), jsonPlan(input)]);
  const planner = new QwenPlanner({ client, config: plannerConfig });
  const plan = await planner.plan(input);
  assert.equal(plan.planId, input.payload.requestedPlanId);
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls.every((call) => call.options.tools.length === 0));
});

test("hidden units become implicit KEEP after validation", async () => {
  const current = snapshot();
  const limitedConfig = { ...plannerConfig, maxVisibleUnits: 3 };
  const bounded = inputFor(current, limitedConfig);
  const visibleEvidence = bounded.visibleUnitIds.find((id) => id === "cu_planner_000003");
  const client = new FakePlannerClient([
    jsonPlan(bounded, [{ unitId: visibleEvidence, action: "EXTERNALIZE" }])
  ]);
  const planner = new QwenPlanner({ client, config: limitedConfig });
  const result = await generateSemanticProposal({
    planner,
    inventory: current,
    pressure,
    task,
    config: limitedConfig
  });
  assert.equal(result.status, "VALIDATED");
  assert.equal(result.hiddenUnitIds.length, 3);
  for (const hiddenId of result.hiddenUnitIds) {
    const evaluated = result.validatedPlan.decisions.find((entry) => entry.unitId === hiddenId);
    assert.equal(evaluated.proposedAction, "KEEP");
    assert.equal(evaluated.importance, null);
  }
});

test("Validator rejection stops without autonomous semantic replanning", async () => {
  const current = snapshot();
  const bounded = inputFor(current);
  const client = new FakePlannerClient([
    jsonPlan(bounded, [{ unitId: "cu_planner_000001", action: "EVICT" }]),
    jsonPlan(bounded)
  ]);
  const planner = new QwenPlanner({ client, config: plannerConfig });
  const result = await generateSemanticProposal({ planner, inventory: current, pressure, task, config: plannerConfig });
  assert.equal(result.status, "VALIDATED");
  assert.equal(result.validatedPlan.status, "REJECTED");
  assert.equal(result.fallbackRequired, true);
  assert.equal(client.calls.length, 1);
  assert.equal(result.metrics.rejectedDecisions, 1);
  assert.equal(result.metrics.illegalProposalRate, 1);
  assert.equal(result.metrics.proposalAuthorizationRate, 0);
});

test("inventory changing after the model call is stale and does not retry", async () => {
  const original = snapshot();
  const bounded = inputFor(original);
  const client = new FakePlannerClient([jsonPlan(bounded)]);
  const planner = new QwenPlanner({ client, config: plannerConfig });
  const changedUnits = structuredClone(fixture.units);
  changedUnits.push({
    ...changedUnits[1],
    id: "cu_planner_000007",
    content: "A new user turn arrived after planning.",
    createdAt: "2026-08-10T00:06:00.000Z",
    protectedReasons: ["LATEST_USER_TURN"]
  });
  const result = await generateSemanticProposal({
    planner,
    inventory: original,
    pressure,
    task,
    config: plannerConfig,
    currentInventory: async () => snapshot(changedUnits)
  });
  assert.equal(result.status, "STALE_INVENTORY");
  assert.equal(result.fallbackRequired, true);
  assert.equal(client.calls.length, 1);
});

test("Planner telemetry uses session audit, not semantic memory", async () => {
  const current = snapshot();
  const bounded = inputFor(current);
  const records = [];
  const memory = {
    projectMemory: "unchanged",
    appendSession(event) { records.push(structuredClone(event)); }
  };
  const audit = createPlannerSessionAudit(memory);
  const client = new FakePlannerClient([jsonPlan(bounded)]);
  const planner = new QwenPlanner({ client, config: plannerConfig, audit });
  const before = structuredClone({ current, memory: { projectMemory: memory.projectMemory } });
  const result = await generateSemanticProposal({
    planner,
    inventory: current,
    pressure,
    task,
    config: plannerConfig,
    audit
  });
  assert.equal(result.status, "VALIDATED");
  assert.deepEqual(records.map((record) => record.type), [
    "semantic_planner_attempt",
    "semantic_planner_result"
  ]);
  assert.equal(memory.projectMemory, "unchanged");
  assert.deepEqual({ current, memory: { projectMemory: memory.projectMemory } }, before);
  assert.doesNotMatch(JSON.stringify(records), /hidden reasoning/);
});
