import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRuntime } from "../src/agent-runtime.js";
import { MemoryStore } from "../src/memory-store.js";

test("AgentRuntime exposes Runtime-derived evidence metadata to Gateway events", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-gateway-runtime-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectRoot, "source.js"), "export const answer = 42;\n", "utf8");
  const config = {
    contextWindow: 65536,
    reservedOutputTokens: 12288,
    fixedPromptOverheadTokens: 512,
    maxOutputTokens: 1024,
    artifactPersistenceChars: 1,
    staleToolCompressionChars: 800,
    staleToolPreviewChars: 500,
    maxToolOutputChars: 12000,
    maxToolIterations: 4,
    temperature: 0,
    thresholds: { garbageCollect: 0.55, prune: 0.65, semanticCompact: 0.72, hardTransfer: 0.8, failure: 0.9 },
    security: { approvalMode: "writes", allowCommands: false, commandTimeoutSeconds: 1 }
  };
  let call = 0;
  const client = {
    async chat() {
      call += 1;
      if (call === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-read",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "source.js" }) }
            }]
          },
          usage: null
        };
      }
      return { message: { role: "assistant", content: "The answer is 42." }, usage: { total_tokens: 20 } };
    }
  };
  const events = [];
  const runtime = new AgentRuntime({
    projectRoot,
    config,
    client,
    memory: new MemoryStore(projectRoot).initialize(),
    confirm: async () => false,
    onEvent: (event) => events.push(event)
  });

  await runtime.runTurn("Read source.js");
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.equal(toolEnd.name, "read_file");
  assert.equal(toolEnd.ok, true);
  assert.equal(toolEnd.evidence.durable, true);
  assert.match(toolEnd.evidence.artifactId, /^read_file-/);
  assert.equal(toolEnd.evidence.recoveryType, "artifact");
  assert.match(toolEnd.evidence.sha256, /^[a-f0-9]{64}$/);
});
