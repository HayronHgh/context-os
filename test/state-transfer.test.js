import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../src/agent-runtime.js";
import { parseStateTransfer } from "../src/state-transfer.js";

function validTransfer(overrides = {}) {
  return {
    objective: "ship safely",
    userRequirements: [],
    constraints: [],
    architecture: [],
    decisions: [],
    modifiedFiles: [],
    investigatedFiles: [],
    tests: [],
    errors: [],
    rejectedApproaches: [],
    currentState: "hardening",
    nextActions: [],
    ...overrides
  };
}

test("state transfer accepts the exact required schema", () => {
  assert.deepEqual(parseStateTransfer(JSON.stringify(validTransfer())), validTransfer());
});

test("state transfer rejects malformed JSON", () => {
  assert.throws(() => parseStateTransfer("not json"), /not valid JSON/);
});

test("state transfer rejects missing or incorrectly typed fields", () => {
  const missing = validTransfer();
  delete missing.nextActions;
  assert.throws(() => parseStateTransfer(JSON.stringify(missing)), /nextActions must be an array/);
  assert.throws(() => parseStateTransfer(JSON.stringify(validTransfer({ constraints: "none" }))), /constraints must be an array/);
});

test("state transfer rejects unexpected fields", () => {
  assert.throws(() => parseStateTransfer(JSON.stringify(validTransfer({ inventedFact: true }))), /unexpected fields/);
});

test("compaction retries once after invalid model output", async () => {
  const responses = ["not json", JSON.stringify(validTransfer())];
  const client = {
    calls: 0,
    async chat() {
      const content = responses[this.calls];
      this.calls += 1;
      return { message: { content } };
    }
  };
  const result = await AgentRuntime.prototype.compactMessages.call({ client }, [{ role: "user", content: "work" }]);
  assert.equal(client.calls, 2);
  assert.deepEqual(JSON.parse(result), validTransfer());
});

test("compaction fails loudly after two invalid responses", async () => {
  const client = { async chat() { return { message: { content: "still invalid" } }; } };
  await assert.rejects(
    () => AgentRuntime.prototype.compactMessages.call({ client }, [{ role: "user", content: "work" }]),
    /validation failed after 2 attempts/
  );
});
