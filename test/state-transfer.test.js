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
    artifacts: [],
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
    requests: [],
    async chat(messages) {
      this.requests.push(messages);
      const content = responses[this.calls];
      this.calls += 1;
      return { message: { content } };
    }
  };
  const result = await AgentRuntime.prototype.compactMessages.call({ client }, [{
    role: "tool",
    tool_call_id: "call-1",
    name: "run_command",
    content: "test output",
    context_os: {
      durable: true,
      artifactId: "run-command-artifact",
      recoveryType: "artifact",
      originalChars: 11,
      sha256: "a".repeat(64)
    }
  }]);
  assert.equal(client.calls, 2);
  assert.deepEqual(JSON.parse(result), validTransfer());
  assert.match(client.requests[0][1].content, /run-command-artifact/);
});

test("compaction fails loudly after two invalid responses", async () => {
  const client = { async chat() { return { message: { content: "still invalid" } }; } };
  await assert.rejects(
    () => AgentRuntime.prototype.compactMessages.call({ client }, [{ role: "user", content: "work" }]),
    /validation failed after 2 attempts/
  );
});
