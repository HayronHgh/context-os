import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { HostContextBridge } from "../src/host-context-bridge.js";
import { createHostContextBridgeServer } from "../src/host-context-bridge-server.js";

const baseConfig = {
  contextWindow: 1000,
  reservedOutputTokens: 100,
  fixedPromptOverheadTokens: 0,
  maxToolOutputChars: 1000,
  thresholds: { garbageCollect: 0.55, prune: 0.65, semanticCompact: 0.72, hardTransfer: 0.8, failure: 0.9 }
};

function validTransfer() {
  return JSON.stringify({
    objective: "continue the task",
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
    currentState: "older turns compacted",
    nextActions: []
  });
}

test("bridge leaves a small request unchanged and caches the exact result", async () => {
  const compactor = { calls: 0, async compact() { this.calls += 1; return validTransfer(); } };
  const bridge = new HostContextBridge({ agentConfig: baseConfig, compactor });
  const payload = { schemaVersion: 1, conversationId: "conv-1", messages: [{ role: "user", content: "hello" }], tools: [] };
  const first = await bridge.prepare(payload);
  const second = await bridge.prepare(payload);
  assert.equal(first.status, "UNCHANGED");
  assert.deepEqual(first.messages, payload.messages);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(compactor.calls, 0);
});

test("bridge accepts an assistant tool-call message with omitted content", async () => {
  const bridge = new HostContextBridge({
    agentConfig: baseConfig,
    compactor: { async compact() { return validTransfer(); } }
  });
  const result = await bridge.prepare({
    schemaVersion: 1,
    conversationId: "conv-tool-call",
    messages: [
      { role: "user", content: "inspect the project" },
      {
        role: "assistant",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "call-1", content: "result" }
    ],
    tools: []
  });
  assert.equal(result.status, "UNCHANGED");
  assert.equal("content" in result.messages[1], false);
  assert.equal(result.messages[1].tool_calls[0].id, "call-1");
});

test("bridge still rejects omitted content on ordinary messages", async () => {
  const bridge = new HostContextBridge({
    agentConfig: baseConfig,
    compactor: { async compact() { return validTransfer(); } }
  });
  await assert.rejects(
    () => bridge.prepare({ schemaVersion: 1, messages: [{ role: "user" }] }),
    /content is required/
  );
});

test("bridge performs semantic state transfer before the model request", async () => {
  const compactor = { calls: 0, async compact() { this.calls += 1; return validTransfer(); } };
  const bridge = new HostContextBridge({ agentConfig: baseConfig, compactor });
  const result = await bridge.prepare({
    schemaVersion: 1,
    conversationId: "conv-large",
    messages: [
      { role: "user", content: "old objective" },
      { role: "assistant", content: "x".repeat(1600) },
      { role: "user", content: "middle work" },
      { role: "assistant", content: "y".repeat(1600) },
      { role: "user", content: "latest request" }
    ],
    tools: []
  });
  assert.equal(result.status, "PREPARED");
  assert.equal(compactor.calls, 1);
  assert.ok(result.report.actions.includes("hard-state-transfer"));
  assert.equal(result.messages[0].role, "system");
  assert.match(result.messages[0].content, /ContextOS manages bounded continuation state/);
  assert.match(result.messages[0].content, /CODING STATE TRANSFER/);
  assert.equal(result.messages.filter((message) => message.role === "system").length, 1);
  assert.equal(result.messages.at(-1).content, "latest request");
  assert.equal(result.report.browserHistoryPreserved, true);
  assert.equal(result.report.failure, false);
});

test("bridge moves a generated state transfer ahead of a leading developer message", async () => {
  const bridge = new HostContextBridge({
    agentConfig: baseConfig,
    compactor: { async compact() { return validTransfer(); } }
  });
  const result = await bridge.prepare({
    schemaVersion: 1,
    conversationId: "conv-developer-prefix",
    messages: [
      { role: "developer", content: "developer rules" },
      { role: "user", content: "old objective" },
      { role: "assistant", content: "x".repeat(3200) },
      { role: "user", content: "latest request" }
    ],
    tools: []
  });
  assert.equal(result.status, "PREPARED");
  assert.equal(result.messages[0].role, "system");
  assert.match(result.messages[0].content, /CODING STATE TRANSFER/);
  assert.equal(result.messages[1].role, "developer");
  assert.equal(result.messages.filter((message) => message.role === "system").length, 1);
});

test("bridge fails closed if the newest work window cannot fit", async () => {
  const bridge = new HostContextBridge({ agentConfig: baseConfig, compactor: { async compact() { return validTransfer(); } } });
  await assert.rejects(() => bridge.prepare({
    schemaVersion: 1,
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "z".repeat(4000) }
    ]
  }), /remains above the failure threshold/);
});

test("HTTP bridge enforces origin and request schema", async (t) => {
  const compactor = { async compact() { return validTransfer(); } };
  const bridge = new HostContextBridge({ agentConfig: baseConfig, compactor });
  const config = { allowedOrigins: ["http://127.0.0.1:8080"], maximumRequestBytes: 4096 };
  const server = createHostContextBridgeServer({ bridge, config, agentConfig: baseConfig });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "context-os-host-bridge");

  const denied = await fetch(`http://127.0.0.1:${port}/v1/context/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.invalid" },
    body: JSON.stringify({ schemaVersion: 1, messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(denied.status, 403);

  const accepted = await fetch(`http://127.0.0.1:${port}/v1/context/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:8080" },
    body: JSON.stringify({ schemaVersion: 1, messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("access-control-allow-origin"), "http://127.0.0.1:8080");
});
