import test from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../src/context-manager.js";

const config = {
  contextWindow: 1000,
  reservedOutputTokens: 100,
  fixedPromptOverheadTokens: 0,
  maxToolOutputChars: 1000,
  thresholds: { garbageCollect: 0.55, prune: 0.65, semanticCompact: 0.72, hardTransfer: 0.8, failure: 0.9 }
};

test("force compaction keeps system and latest user turn", async () => {
  const manager = new ContextManager(config);
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "first task" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "latest task" },
    { role: "assistant", content: "working" }
  ];
  const result = await manager.prepare(messages, async () => '{"currentState":"first task complete"}', { force: true });
  assert.equal(result.messages[0].role, "system");
  assert.match(result.messages[1].content, /CODING STATE TRANSFER/);
  assert.equal(result.messages[2].content, "latest task");
  assert.ok(result.report.actions.includes("hard-state-transfer"));
});

test("context accounting includes tool schemas and fixed prompt overhead", () => {
  const manager = new ContextManager({ ...config, fixedPromptOverheadTokens: 64 });
  const messages = [{ role: "system", content: "rules" }];
  const tools = [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read one file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  }];
  const withoutTools = manager.estimateComponents(messages);
  const withTools = manager.estimateComponents(messages, tools);
  assert.equal(withoutTools.fixedPromptOverheadTokens, 64);
  assert.ok(withTools.toolTokens > 0);
  assert.equal(withTools.totalTokens, withTools.messageTokens + withTools.toolTokens + 64);
  assert.ok(withTools.totalTokens > withoutTools.totalTokens);
});

test("conversation pruning removes complete stale tool exchanges without orphaning results", () => {
  const manager = new ContextManager(config);
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "", tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call-1", name: "read_file", content: "old result" },
    ...Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `recent ${index}` }))
  ];
  const pruned = manager.pruneStaleToolTurns(messages);
  assert.equal(pruned.some((message) => message.tool_call_id === "call-1"), false);
  assert.equal(pruned.some((message) => message.tool_calls?.some((call) => call.id === "call-1")), false);
  assert.ok(pruned.some((message) => /tool exchange pruned/.test(message.content)));
});

test("hard transfer retains only the latest user work window", async () => {
  const manager = new ContextManager(config);
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "x".repeat(900) },
    { role: "user", content: "middle task" },
    { role: "assistant", content: "y".repeat(900) },
    { role: "user", content: "latest task" },
    { role: "assistant", content: "working" }
  ];
  const result = await manager.prepare(messages, async () => '{"objective":"continue"}');
  assert.ok(result.report.actions.includes("hard-state-transfer"));
  assert.equal(result.messages[2].content, "latest task");
  assert.equal(result.messages.some((message) => message.content === "middle task"), false);
});

test("semantic compaction retains more than the latest user work window", async () => {
  const semanticConfig = {
    ...config,
    thresholds: { garbageCollect: 0.01, prune: 0.02, semanticCompact: 0.03, hardTransfer: 0.99, failure: 2 }
  };
  const manager = new ContextManager(semanticConfig);
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "middle task" },
    { role: "assistant", content: "middle answer" },
    { role: "user", content: "latest task" }
  ];
  const result = await manager.prepare(messages, async () => '{"objective":"continue"}');
  assert.ok(result.report.actions.includes("semantic-compaction"));
  assert.equal(result.messages.some((message) => message.content === "middle task"), true);
  assert.equal(result.messages.some((message) => message.content === "latest task"), true);
});

test("failure threshold is reported when the newest work window still cannot fit", async () => {
  const manager = new ContextManager(config);
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "z".repeat(4000) }
  ];
  const result = await manager.prepare(messages, async () => '{"objective":"continue"}');
  assert.equal(result.report.failure, true);
  assert.ok(result.report.finalRatio >= config.thresholds.failure);
});

test("stale tool output is pruned without breaking tool message", async () => {
  const manager = new ContextManager(config);
  const messages = [{ role: "system", content: "rules" }];
  for (let index = 0; index < 20; index += 1) messages.push({ role: "tool", tool_call_id: String(index), content: "x".repeat(1000) });
  const pruned = manager.pruneStaleToolOutputs(messages);
  assert.equal(pruned[1].role, "tool");
  assert.match(pruned[1].content, /pruned/);
  assert.equal(pruned.at(-1).content.length, 1000);
});
