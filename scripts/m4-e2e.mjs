import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentConfig } from "../src/config.js";
import { ContextInventory } from "../src/context-inventory.js";
import { LlamaClient } from "../src/llama-client.js";
import { QwenPlanner } from "../src/planners/qwen-planner.js";
import { generateSemanticProposal } from "../src/semantic-proposal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = process.env.CONTEXT_OS_AGENT_CONFIG
  ? path.resolve(process.env.CONTEXT_OS_AGENT_CONFIG)
  : path.join(root, "config", "agent.json");
if (!fs.existsSync(configFile)) {
  throw new Error("M4 E2E requires config/agent.json or CONTEXT_OS_AGENT_CONFIG");
}
const config = normalizeAgentConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, "test", "fixtures", "planner", "inventory-units.json"),
  "utf8"
));
const inventory = new ContextInventory({ sessionId: "m4e2e" });
for (const sourceUnit of fixture.units) {
  inventory.register({
    ...sourceUnit,
    id: sourceUnit.id.replace("cu_planner_", "cu_m4e2e_"),
    dependencies: sourceUnit.dependencies.map((dependency) => ({
      ...dependency,
      unitId: dependency.unitId.replace("cu_planner_", "cu_m4e2e_")
    }))
  });
}

const snapshot = inventory.snapshot({ includeContent: true });
const pressure = { ratio: 0.74, requiredReductionTokens: 2000 };
const task = {
  objective: "Preserve the public API and durable refresh-race evidence while reducing stale context",
  phase: "investigation"
};
const before = structuredClone(snapshot);
const audits = [];
const client = new LlamaClient(config);
await client.health();
const planner = new QwenPlanner({
  client,
  config: config.planner,
  audit: (event) => audits.push(structuredClone(event))
});
const result = await generateSemanticProposal({
  planner,
  inventory: snapshot,
  pressure,
  task,
  config: config.planner,
  audit: (event) => audits.push(structuredClone(event))
});

if (result.status !== "VALIDATED") {
  console.error(JSON.stringify({
    result,
    attempts: audits.map((event) => ({
      type: event.type,
      attempt: event.attempt ?? null,
      parseResult: event.parseResult ?? null,
      errorCode: event.errorCode ?? null,
      errorPath: event.errorPath ?? null
    }))
  }, null, 2));
}
assert.equal(result.status, "VALIDATED");
assert.equal(result.plan.schemaVersion, 1);
assert.ok(result.plan.decisions.every((decision) => result.visibleUnitIds.includes(decision.unitId)));
assert.equal(result.validatedPlan.schemaVersion, 1);
assert.equal(result.validatedPlan.runtime.actualReductionTokens, null);
assert.deepEqual(snapshot, before);
assert.ok(audits.some((event) => event.type === "semantic_planner_attempt"));
assert.ok(audits.some((event) => event.type === "semantic_planner_result"));

console.log(JSON.stringify({
  planId: result.plan.planId,
  validatorStatus: result.validatedPlan.status,
  fallbackRequired: result.fallbackRequired,
  metrics: result.metrics
}, null, 2));
console.log("V020_M4_E2E_OK");
