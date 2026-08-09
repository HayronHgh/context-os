import test from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../src/context-manager.js";

const config = {
  contextWindow: 1000,
  reservedOutputTokens: 100,
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
  assert.ok(result.report.actions.includes("semantic-compaction"));
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
