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

function linkOrSkip(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`Symbolic links are unavailable in this environment: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test("file symlinks cannot escape through read, write, or edit tools", async (t) => {
  const { root, runner } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-outside-"));
  try {
    const target = path.join(outside, "secret.txt");
    fs.writeFileSync(target, "secret", "utf8");
    if (!linkOrSkip(t, target, path.join(root, "linked-secret.txt"), "file")) return;
    await assert.rejects(() => runner.execute("read_file", { path: "linked-secret.txt" }), /symbolic link or junction/);
    await assert.rejects(() => runner.execute("write_file", { path: "linked-secret.txt", content: "changed" }), /symbolic link or junction/);
    await assert.rejects(() => runner.execute("edit_file", { path: "linked-secret.txt", oldText: "secret", newText: "changed" }), /symbolic link or junction/);
    assert.equal(fs.readFileSync(target, "utf8"), "secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("directory symlinks or junctions cannot escape through nested paths", async (t) => {
  const { root, runner } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    const type = process.platform === "win32" ? "junction" : "dir";
    if (!linkOrSkip(t, outside, path.join(root, "outside-link"), type)) return;
    await assert.rejects(() => runner.execute("read_file", { path: "outside-link/secret.txt" }), /symbolic link or junction/);
    await assert.rejects(() => runner.execute("write_file", { path: "outside-link/new.txt", content: "escape" }), /symbolic link or junction/);
    await assert.rejects(() => runner.execute("edit_file", { path: "outside-link/secret.txt", oldText: "secret", newText: "changed" }), /symbolic link or junction/);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("an interrupted atomic write does not replace the last valid state", () => {
  const { root, memory } = fixture();
  try {
    memory.updateState({ objective: "stable" });
    fs.writeFileSync(`${memory.stateFile}.interrupted.tmp`, "{broken", "utf8");
    assert.equal(memory.getState().objective, "stable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupted working state fails loudly", () => {
  const { root, memory } = fixture();
  try {
    fs.writeFileSync(memory.stateFile, "{broken", "utf8");
    assert.throws(() => memory.getState(), /JSON/);
    fs.writeFileSync(memory.repoMapFile, "{broken", "utf8");
    assert.deepEqual(memory.readRepoMap(), {
      generatedAt: null,
      files: [],
      recoveredFromCorruption: true
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupted newest episodes do not hide the latest requested valid episode", () => {
  const { root, memory } = fixture();
  try {
    memory.saveEpisode({ task: "valid", solution: "kept" });
    fs.writeFileSync(path.join(memory.episodesDir, "episode-zzzz-corrupt.json"), "{broken", "utf8");
    const episodes = memory.listEpisodes(1);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].solution, "kept");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read_artifact retrieves exact content and metadata through the tool interface", async () => {
  const { root, memory, runner } = fixture();
  try {
    const text = "first\nsecond\nthird";
    const artifact = memory.saveArtifact(text, "test_tool", { tool: "test_tool", arguments: {} });
    const result = await runner.execute("read_artifact", { artifactId: artifact.id });
    assert.equal(result.content, text);
    assert.equal(result.metadata.chars, text.length);
    assert.equal(result.metadata.bytes, Buffer.byteLength(text));
    assert.match(result.metadata.sha256, /^[a-f0-9]{64}$/);
    assert.equal(memory.listArtifacts(1)[0].id, artifact.id);
    assert.equal(runner.readWorkingState().recentArtifacts[0].id, artifact.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read_artifact rejects invalid or unknown artifact IDs", async () => {
  const { root, runner } = fixture();
  try {
    await assert.rejects(() => runner.execute("read_artifact", { artifactId: "../state" }), /Invalid artifact ID/);
    await assert.rejects(() => runner.execute("read_artifact", { artifactId: "missing-artifact" }), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read_artifact range is bounded to 500 lines", () => {
  const { root, memory } = fixture();
  try {
    const text = Array.from({ length: 700 }, (_, index) => `line-${index + 1}`).join("\n");
    const artifact = memory.saveArtifact(text, "range");
    const result = memory.readArtifact(artifact.id, { startLine: 2, endLine: 700 });
    const lines = result.content.split("\n");
    assert.equal(lines.length, 500);
    assert.equal(lines[0], "line-2");
    assert.equal(lines.at(-1), "line-501");
    assert.equal(result.endLine, 501);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read_artifact fails integrity validation after content tampering", () => {
  const { root, memory } = fixture();
  try {
    const artifact = memory.saveArtifact("original", "integrity");
    fs.writeFileSync(path.join(memory.artifactsDir, `${artifact.id}.txt`), "tampered", "utf8");
    assert.throws(() => memory.readArtifact(artifact.id), /integrity check failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read_artifact rejects an artifact-directory junction escape", (t) => {
  const { root, memory } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-artifact-outside-"));
  try {
    fs.rmSync(memory.artifactsDir, { recursive: true, force: true });
    const type = process.platform === "win32" ? "junction" : "dir";
    if (!linkOrSkip(t, outside, memory.artifactsDir, type)) return;
    fs.writeFileSync(path.join(outside, "escape.json"), JSON.stringify({ id: "escape" }), "utf8");
    fs.writeFileSync(path.join(outside, "escape.txt"), "secret", "utf8");
    assert.throws(() => memory.readArtifact("escape"), /Artifact directory escapes project root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
