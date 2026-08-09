import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../src/gateway-server.js";

function fixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-gateway-"));
  const client = {
    async health() { return { status: "ok" }; },
    async models() { return { data: [{ id: "qwen-test" }] }; }
  };
  const runtimeFactory = ({ confirm, onEvent }) => ({
    async checkHealth() { return { health: { status: "ok" }, models: ["qwen-test"] }; },
    async runTurn(content) {
      onEvent({ type: "tool_start", name: "read_file" });
      onEvent({
        type: "tool_end",
        name: "read_file",
        ok: true,
        evidence: { durable: true, artifactId: "artifact-test", recoveryType: "artifact" }
      });
      if (content === "mutate") {
        const approved = await confirm("write_file: src/example.js");
        onEvent({ type: "tool_end", name: "write_file", ok: approved, denied: !approved });
      }
      onEvent({ type: "assistant", content: `answer:${content}` });
      return { content: `answer:${content}`, usage: { total_tokens: 12 } };
    }
  });
  const gateway = createGatewayServer({ runtimeFactory, client, defaultProjectRoot: projectRoot, approvalTimeoutMs: 1_000 });
  return { projectRoot, gateway };
}

async function startGateway(value) {
  const address = await value.gateway.listen({ port: 0 });
  return `http://127.0.0.1:${address.port}`;
}

async function createSession(baseUrl, projectRoot) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot })
  });
  assert.equal(response.status, 201);
  return response.json();
}

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
}

test("Gateway serves the CSP-protected UI and health/config APIs", async (t) => {
  const value = fixture();
  t.after(async () => {
    await value.gateway.close();
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  });
  const baseUrl = await startGateway(value);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await page.text(), /ContextOS Runtime/);

  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.apiVersion, 1);
  assert.equal(config.defaultProjectRoot, value.projectRoot);
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.status, "ready");
  assert.deepEqual(health.models, ["qwen-test"]);
});

test("Gateway creates a session and routes a turn through its owned runtime", async (t) => {
  const value = fixture();
  t.after(async () => {
    await value.gateway.close();
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  });
  const baseUrl = await startGateway(value);
  const created = await createSession(baseUrl, value.projectRoot);
  assert.equal(created.session.projectRoot, fs.realpathSync.native(value.projectRoot));

  const duplicate = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: value.projectRoot })
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "PROJECT_SESSION_ACTIVE");

  const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "inspect" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "answer:inspect");
  const trace = value.gateway.sessions.get(created.session.id).history;
  assert.deepEqual(trace.map((entry) => entry.type), [
    "session_ready", "turn_start", "tool_start", "tool_end", "assistant", "turn_complete"
  ]);
  assert.equal(trace.find((entry) => entry.type === "tool_end").data.evidence.artifactId, "artifact-test");
});

test("Gateway streams replayable SSE runtime events", async (t) => {
  const value = fixture();
  t.after(async () => {
    await value.gateway.close();
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  });
  const baseUrl = await startGateway(value);
  const created = await createSession(baseUrl, value.projectRoot);
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("event: session_ready")) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value ?? new Uint8Array());
  }
  controller.abort();
  assert.match(text, /data: .*sessionId/);
});

test("Gateway holds a mutation turn until the browser resolves approval", async (t) => {
  const value = fixture();
  t.after(async () => {
    await value.gateway.close();
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  });
  const baseUrl = await startGateway(value);
  const created = await createSession(baseUrl, value.projectRoot);
  const turn = fetch(`${baseUrl}/api/sessions/${created.session.id}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "mutate" })
  });

  let approval;
  for (let attempt = 0; attempt < 100 && !approval; attempt += 1) {
    approval = value.gateway.sessions.get(created.session.id).history.find((entry) => entry.type === "approval_required");
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(approval);

  const overlapping = await fetch(`${baseUrl}/api/sessions/${created.session.id}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "second" })
  });
  assert.equal(overlapping.status, 409);

  const decision = await fetch(`${baseUrl}/api/sessions/${created.session.id}/approvals/${approval.data.approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: false })
  });
  assert.equal(decision.status, 200);
  assert.equal((await turn).status, 200);
  const resolved = value.gateway.sessions.get(created.session.id).history.find((entry) => entry.type === "approval_resolved");
  assert.equal(resolved.data.approved, false);
});

test("Gateway rejects cross-site requests, invalid roots, and non-JSON mutation requests", async (t) => {
  const value = fixture();
  t.after(async () => {
    await value.gateway.close();
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  });
  const baseUrl = await startGateway(value);

  assert.equal(await requestWithHost(`${baseUrl}/api/config`, "evil.example"), 421);

  const crossSite = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: value.projectRoot })
  });
  assert.equal(crossSite.status, 403);

  const invalid = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: path.join(value.projectRoot, "missing") })
  });
  assert.equal(invalid.status, 400);

  const mediaType = await fetch(`${baseUrl}/api/sessions`, { method: "POST", body: "{}" });
  assert.equal(mediaType.status, 415);
});

test("Gateway session deletion denies pending work and removes the runtime", async (t) => {
  const value = fixture();
  t.after(async () => {
    await value.gateway.close();
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  });
  const baseUrl = await startGateway(value);
  const created = await createSession(baseUrl, value.projectRoot);
  const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal(value.gateway.sessions.has(created.session.id), false);
  const missing = await fetch(`${baseUrl}/api/sessions/${created.session.id}`);
  assert.equal(missing.status, 404);
});
