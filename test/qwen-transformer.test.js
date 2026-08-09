import assert from "node:assert/strict";
import test from "node:test";
import {
  QwenTransformer,
  TRANSFORMER_PROMPT_VERSION,
  TransformationError,
  normalizeTransformerConfig
} from "../src/qwen-transformer.js";

const config = {
  maxInputTokens: 12000,
  maxOutputTokens: 512,
  temperature: 0.1,
  maxAttempts: 2
};

const input = {
  schemaVersion: 1,
  unitId: "cu_transformer_000001",
  kind: "TOOL_EVIDENCE",
  authority: "DERIVED",
  targetTokens: 10,
  content: "A long source unit with commands, paths, errors, facts, and unresolved state."
};

class FakeClient {
  constructor(outputs) {
    this.outputs = [...outputs];
    this.calls = [];
  }

  async chat(messages, options) {
    this.calls.push(structuredClone({ messages, options }));
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    const fixture = typeof output === "object" && output !== null
      ? output
      : { content: output };
    return {
      message: { content: fixture.content, reasoning_content: "never consumed" },
      usage: fixture.usage ?? { prompt_tokens: 100, completion_tokens: 20 }
    };
  }
}

test("transformer-v1 is isolated, tool-free, bounded, and returns content only", async () => {
  const oversized = "candidate output may exceed target tokens because D4 owns acceptance";
  const client = new FakeClient([JSON.stringify({ content: oversized })]);
  const transformer = new QwenTransformer({ client, config });
  const content = await transformer.compress(input);
  assert.equal(content, oversized);
  assert.equal(TRANSFORMER_PROMPT_VERSION, "transformer-v1");
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].options.tools, []);
  assert.deepEqual(client.calls[0].options.chatTemplateKwargs, { enable_thinking: false });
  assert.deepEqual(client.calls[0].options.responseFormat, { type: "json_object" });
  assert.equal(client.calls[0].options.temperature, 0.1);
  assert.equal(client.calls[0].options.maxTokens, 512);
  const payload = JSON.parse(client.calls[0].messages[1].content);
  assert.deepEqual(payload, input);
  assert.equal(Object.hasOwn(payload, "action"), false);
  assert.equal(Object.hasOwn(payload, "recoverability"), false);
});

test("malformed JSON gets exactly one schema-only repair", async () => {
  const client = new FakeClient(["not-json", JSON.stringify({ content: "repaired" })]);
  const transformer = new QwenTransformer({ client, config });
  assert.equal(await transformer.compress(input), "repaired");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].messages.length, 3);
  assert.match(client.calls[1].messages[2].content, /MALFORMED_JSON/);
  assert.doesNotMatch(client.calls[1].messages[2].content, /not-json/);
});

test("model metadata is rejected and cannot replace Runtime-owned fields", async () => {
  const client = new FakeClient([
    JSON.stringify({ content: "candidate", unitId: "cu_attacker_000001", action: "EVICT" }),
    JSON.stringify({ content: "candidate" })
  ]);
  const transformer = new QwenTransformer({ client, config });
  assert.equal(await transformer.compress(input), "candidate");
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].messages[2].content, /SCHEMA_VIOLATION/);
});

test("two invalid outputs fail closed and transport errors do not retry", async () => {
  const invalidClient = new FakeClient(["bad-one", "bad-two"]);
  const invalid = new QwenTransformer({ client: invalidClient, config });
  await assert.rejects(() => invalid.compress(input), (error) => {
    assert.ok(error instanceof TransformationError);
    assert.equal(error.code, "TRANSFORMER_FAILED");
    assert.equal(error.causeCode, "MALFORMED_JSON");
    assert.equal(error.attempts, 2);
    return true;
  });
  assert.equal(invalidClient.calls.length, 2);

  const failingClient = new FakeClient([new Error("transport failed"), JSON.stringify({ content: "unused" })]);
  const failing = new QwenTransformer({ client: failingClient, config });
  await assert.rejects(() => failing.compress(input), (error) => {
    assert.equal(error.code, "TRANSFORMER_FAILED");
    assert.equal(error.causeCode, "TRANSFORMER_CLIENT_ERROR");
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(failingClient.calls.length, 1);
});

test("transformer configuration is independent and bounded", () => {
  const normalized = normalizeTransformerConfig();
  assert.equal(normalized.maxInputTokens, 12000);
  assert.equal(normalized.maxOutputTokens, 2048);
  assert.equal(normalized.temperature, 0.1);
  assert.equal(normalized.maxAttempts, 2);
  assert.throws(
    () => normalizeTransformerConfig({ maxAttempts: 3 }),
    /maxAttempts must be <= 2/
  );
});
