import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAgentConfig } from "../src/config.js";
import { serializeMessageForModel } from "../src/context-messages.js";
import { MemoryStore } from "../src/memory-store.js";
import { ToolEvidenceManager } from "../src/tool-evidence.js";

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-evidence-"));
  const memory = new MemoryStore(root).initialize();
  const config = {
    artifactPersistenceChars: 80,
    staleToolCompressionChars: 80,
    staleToolPreviewChars: 40,
    maxToolOutputChars: 256,
    ...overrides
  };
  const manager = new ToolEvidenceManager({ memory, config });
  return { root, memory, manager };
}

test("durability config rejects persistence later than destructive compression", () => {
  assert.throws(
    () => normalizeAgentConfig({ artifactPersistenceChars: 801, staleToolCompressionChars: 800 }),
    /artifactPersistenceChars must be <= staleToolCompressionChars/
  );
  assert.throws(
    () => normalizeAgentConfig({ staleToolPreviewChars: 801, staleToolCompressionChars: 800 }),
    /staleToolPreviewChars must be <= staleToolCompressionChars/
  );
});

test("small tool output may remain context-only", () => {
  const { root, manager } = fixture({ artifactPersistenceChars: 200, staleToolCompressionChars: 200 });
  try {
    const value = manager.createToolMessage({ toolCallId: "small", name: "get_datetime", arguments: {}, result: { ok: true } });
    assert.equal(value.artifact, null);
    assert.equal(value.message.context_os.durable, false);
    assert.equal(value.message.context_os.recoveryType, "context-only");
    assert.equal(value.message.content, value.prepared.fullText);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("medium tool output is persisted while its full representation stays active", () => {
  const { root, memory, manager } = fixture();
  try {
    const value = manager.createToolMessage({
      toolCallId: "medium",
      name: "grep_search",
      arguments: { query: "needle" },
      result: { matches: ["x".repeat(120)] }
    });
    assert.ok(value.artifact);
    assert.equal(value.message.content, value.prepared.fullText);
    assert.equal(value.message.context_os.durable, true);
    assert.equal(memory.readArtifact(value.artifact.id).content, value.prepared.fullText);
    assert.equal(value.artifact.chars, value.prepared.originalChars);
    assert.equal(value.artifact.bytes, value.prepared.bytes);
    assert.match(value.artifact.sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large tool output is persisted exactly and rendered within the prompt limit", () => {
  const { root, memory, manager } = fixture();
  try {
    const value = manager.createToolMessage({
      toolCallId: "large",
      name: "run_command",
      arguments: { command: "test" },
      result: { stdout: "x".repeat(2000) }
    });
    assert.ok(value.artifact);
    assert.ok(value.message.content.length <= 256);
    assert.match(value.message.content, new RegExp(value.artifact.id));
    assert.equal(memory.readArtifact(value.artifact.id).content, value.prepared.fullText);
    assert.deepEqual(value.metrics, {
      artifactsCreated: 1,
      artifactCharsPersisted: value.prepared.originalChars
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model serialization preserves protocol fields and strips runtime metadata", () => {
  const internal = {
    role: "tool",
    tool_call_id: "call-1",
    name: "read_file",
    content: "result",
    context_os: { durable: true, artifactId: "artifact-1" }
  };
  const serialized = serializeMessageForModel(internal);
  assert.deepEqual(serialized, {
    role: "tool",
    content: "result",
    name: "read_file",
    tool_call_id: "call-1"
  });
  assert.equal("context_os" in serialized, false);
});
