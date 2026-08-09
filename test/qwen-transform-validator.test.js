import assert from "node:assert/strict";
import test from "node:test";
import {
  QwenTransformValidator,
  TRANSFORM_VALIDATOR_PROMPT_VERSION,
  TransformValidationError,
  normalizeTransformValidatorConfig
} from "../src/qwen-transform-validator.js";

const config = {
  maxInputTokens: 24000,
  maxOutputTokens: 256,
  temperature: 0,
  maxAttempts: 2
};
const input = {
  schemaVersion: 1,
  originalContent: "Constraint A, identifier API_42, error E_FAIL unresolved.",
  candidateContent: "Keep constraint A, API_42, and unresolved E_FAIL.",
  kind: "TOOL_EVIDENCE",
  authority: "DERIVED",
  protectedReasons: []
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
    return { message: { content: output, reasoning_content: "not consumed" } };
  }
}

test("transform-validator-v1 is isolated, tool-free, and assessment-only", async () => {
  const client = new FakeClient([JSON.stringify({ verdict: "ACCEPT", reasonCodes: [] })]);
  const validator = new QwenTransformValidator({ client, config });
  const assessment = await validator.assess(input);
  assert.equal(TRANSFORM_VALIDATOR_PROMPT_VERSION, "transform-validator-v1");
  assert.deepEqual(assessment, { verdict: "ACCEPT", reasonCodes: [] });
  assert.ok(Object.isFrozen(assessment));
  assert.ok(Object.isFrozen(assessment.reasonCodes));
  assert.deepEqual(client.calls[0].options.tools, []);
  assert.deepEqual(client.calls[0].options.chatTemplateKwargs, { enable_thinking: false });
  assert.deepEqual(client.calls[0].options.responseFormat, { type: "json_object" });
  assert.equal(client.calls[0].options.temperature, 0);
  assert.deepEqual(JSON.parse(client.calls[0].messages[1].content), input);
  assert.equal(Object.hasOwn(assessment, "content"), false);
});

test("strict semantic reason codes support rejection", async () => {
  const client = new FakeClient([JSON.stringify({
    verdict: "REJECT",
    reasonCodes: ["FACT_LOST", "UNRESOLVED_STATE_LOST"]
  })]);
  const validator = new QwenTransformValidator({ client, config });
  assert.deepEqual(await validator.assess(input), {
    verdict: "REJECT",
    reasonCodes: ["FACT_LOST", "UNRESOLVED_STATE_LOST"]
  });
});

test("malformed or authority-widening output gets one schema-only repair", async () => {
  const malformedClient = new FakeClient([
    "not-json",
    JSON.stringify({ verdict: "ACCEPT", reasonCodes: [] })
  ]);
  const malformed = new QwenTransformValidator({ client: malformedClient, config });
  await malformed.assess(input);
  assert.equal(malformedClient.calls.length, 2);
  assert.match(malformedClient.calls[1].messages[2].content, /MALFORMED_JSON/);
  assert.doesNotMatch(malformedClient.calls[1].messages[2].content, /not-json/);

  const metadataClient = new FakeClient([
    JSON.stringify({ verdict: "ACCEPT", reasonCodes: [], candidateContent: "modified" }),
    JSON.stringify({ verdict: "REJECT", reasonCodes: ["MEANING_CHANGED"] })
  ]);
  const metadata = new QwenTransformValidator({ client: metadataClient, config });
  assert.deepEqual(await metadata.assess(input), {
    verdict: "REJECT",
    reasonCodes: ["MEANING_CHANGED"]
  });
  assert.match(metadataClient.calls[1].messages[2].content, /SCHEMA_VIOLATION/);
});

test("repeated invalid output and client failure fail closed", async () => {
  const invalidClient = new FakeClient(["bad-one", "bad-two"]);
  const invalid = new QwenTransformValidator({ client: invalidClient, config });
  await assert.rejects(() => invalid.assess(input), (error) => {
    assert.ok(error instanceof TransformValidationError);
    assert.equal(error.code, "SEMANTIC_VALIDATION_FAILED");
    assert.equal(error.causeCode, "MALFORMED_JSON");
    assert.equal(error.attempts, 2);
    return true;
  });
  assert.equal(invalidClient.calls.length, 2);

  const failedClient = new FakeClient([new Error("transport failure")]);
  const failed = new QwenTransformValidator({ client: failedClient, config });
  await assert.rejects(() => failed.assess(input), (error) => {
    assert.equal(error.code, "SEMANTIC_VALIDATION_FAILED");
    assert.equal(error.causeCode, "SEMANTIC_VALIDATOR_CLIENT_ERROR");
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(failedClient.calls.length, 1);
});

test("transform validator configuration is independent and bounded", () => {
  const normalized = normalizeTransformValidatorConfig();
  assert.equal(normalized.maxInputTokens, 24000);
  assert.equal(normalized.maxOutputTokens, 512);
  assert.equal(normalized.temperature, 0);
  assert.equal(normalized.maxAttempts, 2);
  assert.throws(
    () => normalizeTransformValidatorConfig({ maxAttempts: 3 }),
    /maxAttempts must be <= 2/
  );
});
