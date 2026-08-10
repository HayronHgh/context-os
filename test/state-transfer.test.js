import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../src/agent-runtime.js";
import { parseStateTransfer } from "../src/state-transfer.js";
import { StateTransferCompactor } from "../src/state-transfer-compactor.js";
import { estimateTokens } from "../src/utils.js";

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
    options: [],
    async chat(messages, options) {
      this.requests.push(messages);
      this.options.push(options);
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
  assert.deepEqual(client.options[0].responseFormat, { type: "json_object" });
  assert.deepEqual(client.options[0].chatTemplateKwargs, { enable_thinking: false });
});

test("compaction fails loudly after two invalid responses", async () => {
  const client = { async chat() { return { message: { content: "still invalid" } }; } };
  await assert.rejects(
    () => AgentRuntime.prototype.compactMessages.call({ client }, [{ role: "user", content: "work" }]),
    /validation failed after 2 attempts/
  );
});

test("oversized history is reduced through bounded state-transfer chunks", async () => {
  const client = {
    requests: [],
    async chat(messages) {
      this.requests.push(messages);
      return { message: { content: JSON.stringify(validTransfer()) } };
    }
  };
  const compactor = new StateTransferCompactor({
    client,
    maxInputMessageChars: 4000,
    maxInputTokens: 1200
  });
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}:` + "x".repeat(3000)
  }));
  const result = await compactor.compact(messages);
  assert.deepEqual(JSON.parse(result), validTransfer());
  assert.ok(client.requests.length > 2);
  for (const request of client.requests) {
    assert.ok(estimateTokens(request[1].content) <= 1200);
  }
});
