import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory-store.js";
import { RepoMapper } from "../src/repo-mapper.js";
import { ToolRunner } from "../src/tools.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-context-os-"));
  const memory = new MemoryStore(root).initialize();
  const mapper = new RepoMapper(root, memory);
  const config = { security: { approvalMode: "writes", allowCommands: true, commandTimeoutSeconds: 5 } };
  const runner = new ToolRunner({ projectRoot: root, memory, mapper, config, confirm: async () => true });
  return { root, memory, mapper, runner };
}

test("memory survives reload and episodes are listed", () => {
  const { root, memory } = fixture();
  try {
    memory.updateState({ objective: "ship runtime", nextActions: ["test"] });
    memory.saveEpisode({ task: "test", solution: "passed" });
    const reloaded = new MemoryStore(root).initialize();
    assert.equal(reloaded.getState().objective, "ship runtime");
    assert.equal(reloaded.listEpisodes(1)[0].solution, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file tools stay inside project root", async () => {
  const { root, runner } = fixture();
  try {
    await runner.execute("write_file", { path: "src/hello.txt", content: "hello" });
    assert.equal(fs.readFileSync(path.join(root, "src", "hello.txt"), "utf8"), "hello");
    await assert.rejects(() => runner.execute("read_file", { path: "../outside.txt" }), /escapes project root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("destructive commands are denied even after approval", async () => {
  const { root, runner } = fixture();
  try {
    await assert.rejects(() => runner.execute("run_command", { command: "git reset --hard" }), /Destructive command denied/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
