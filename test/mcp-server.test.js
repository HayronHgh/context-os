import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_READ_ONLY_TOOLS, MCP_MUTATION_TOOLS } from "../src/mcp-tools.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(testDirectory, "..");
const serverScript = path.join(applicationRoot, "src", "mcp-server.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-mcp-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "example.txt"), "evidence\n".repeat(300), "utf8");
  return root;
}

async function connect(projectRoot, mode) {
  const args = [serverScript, "--project", projectRoot];
  if (mode) args.push("--mode", mode);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: applicationRoot,
    stderr: "pipe"
  });
  const client = new Client({ name: "context-os-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function envelope(result) {
  return JSON.parse(result.content.find((part) => part.type === "text").text);
}

test("official MCP client negotiates capabilities and read-only mode exposes only intended tools", async () => {
  const root = fixture();
  const { client } = await connect(root);
  try {
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities.tools);
    assert.ok(capabilities.resources);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...MCP_READ_ONLY_TOOLS].sort());
    assert.equal(listed.tools.some((tool) => MCP_MUTATION_TOOLS.includes(tool.name)), false);
    assert.ok(listed.tools.every((tool) => tool.inputSchema.type === "object"));
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP read_file uses ToolRunner containment and the existing durable evidence path", async () => {
  const root = fixture();
  const { client } = await connect(root);
  try {
    const result = await client.callTool({ name: "read_file", arguments: { path: "src/example.txt" } });
    const value = envelope(result);
    assert.equal(value.ok, true);
    assert.equal(value.result.path, "src/example.txt");
    assert.match(value.result.content, /1: evidence/);
    assert.equal(value.evidence.durable, true);
    assert.match(value.evidence.artifactId, /^read_file-/);
    assert.match(value.evidence.sha256, /^[a-f0-9]{64}$/);

    const recovered = envelope(await client.callTool({
      name: "read_artifact",
      arguments: { artifactId: value.evidence.artifactId }
    }));
    assert.equal(recovered.ok, true);
    assert.match(recovered.result.content, /"path": "src\/example.txt"/);

    const escaped = envelope(await client.callTool({ name: "read_file", arguments: { path: "../secret.txt" } }));
    assert.equal(escaped.ok, false);
    assert.equal(escaped.error.code, "PROJECT_ROOT_ESCAPE");
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large MCP results are externalized and remain exactly recoverable as a resource", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "large.txt"), "0123456789abcdef\n".repeat(1200), "utf8");
  const { client } = await connect(root);
  try {
    const value = envelope(await client.callTool({ name: "read_file", arguments: { path: "large.txt" } }));
    assert.equal(value.ok, true);
    assert.equal(value.result.externalized, true);
    assert.equal(value.evidence.durable, true);
    const resourceResult = await client.readResource({ uri: `contextos://artifacts/${value.evidence.artifactId}` });
    const artifact = JSON.parse(resourceResult.contents[0].text);
    assert.equal(artifact.artifactId, value.evidence.artifactId);
    assert.match(artifact.content, /1: 0123456789abcdef/);
    assert.equal(artifact.metadata.sha256, value.evidence.sha256);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resources are bounded, machine-readable, and exclude private conversation history", async () => {
  const root = fixture();
  const { client } = await connect(root);
  try {
    const resources = await client.listResources();
    const uris = resources.resources.map((item) => item.uri);
    assert.ok(uris.includes("contextos://repository/map"));
    assert.ok(uris.includes("contextos://memory/project"));
    assert.ok(uris.includes("contextos://state/working"));
    assert.ok(uris.includes("contextos://artifacts"));
    assert.equal(uris.some((uri) => /session|conversation|transcript/i.test(uri)), false);
    const templates = await client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((item) => item.uriTemplate === "contextos://artifacts/{artifactId}"));
    for (const uri of uris) {
      const result = await client.readResource({ uri });
      assert.doesNotThrow(() => JSON.parse(result.contents[0].text));
      assert.ok(Buffer.byteLength(result.contents[0].text, "utf8") <= 131072);
    }
    fs.writeFileSync(path.join(root, ".qwen-agent", "project.md"), "漢字與程式碼".repeat(30000), "utf8");
    const unicode = await client.readResource({ uri: "contextos://memory/project" });
    const bounded = JSON.parse(unicode.contents[0].text);
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(unicode.contents[0].text, "utf8") <= 131072);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unknown and malformed calls fail closed", async () => {
  const root = fixture();
  const { client } = await connect(root);
  try {
    const unknown = await client.callTool({ name: "write_file", arguments: { path: "x", content: "x" } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /not found|unknown/i);
    const malformed = await client.callTool({ name: "read_file", arguments: {} });
    assert.equal(malformed.isError, true);
    assert.match(malformed.content[0].text, /invalid|validation|required/i);
    assert.equal(fs.existsSync(path.join(root, "x")), false);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trusted-local is explicit, reuses ToolRunner, and command policy still fails closed", async () => {
  const root = fixture();
  const { client } = await connect(root, "trusted-local");
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...MCP_READ_ONLY_TOOLS, ...MCP_MUTATION_TOOLS].sort());
    const written = envelope(await client.callTool({
      name: "write_file",
      arguments: { path: "created.txt", content: "trusted local" }
    }));
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "created.txt"), "utf8"), "trusted local");

    const command = envelope(await client.callTool({ name: "run_command", arguments: { command: "node --version" } }));
    assert.equal(command.ok, false);
    assert.equal(command.error.code, "POLICY_DENIED");
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupted auxiliary artifact metadata does not hide unrelated valid MCP resources", async () => {
  const root = fixture();
  const { client } = await connect(root);
  try {
    const read = envelope(await client.callTool({ name: "read_file", arguments: { path: "src/example.txt" } }));
    const artifactsDirectory = path.join(root, ".qwen-agent", "artifacts");
    fs.writeFileSync(path.join(artifactsDirectory, "zzzz-corrupt.json"), "{broken", "utf8");
    const resourceResult = await client.readResource({ uri: "contextos://artifacts" });
    const index = JSON.parse(resourceResult.contents[0].text);
    assert.ok(index.artifacts.some((artifact) => artifact.id === read.evidence.artifactId));
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("llama.cpp b10295 MCP 2024-11-05 initialize and tools/list smoke", async () => {
  const root = fixture();
  const child = spawn(process.execPath, [serverScript, "--project", root], {
    cwd: applicationRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "llama.cpp", version: "b10295-test" }
    });
    assert.equal(initialized.result.protocolVersion, "2024-11-05");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await request(2, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [...MCP_READ_ONLY_TOOLS].sort());
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
