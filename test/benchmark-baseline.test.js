import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(root, "benchmarks", "baselines", "v0.1.2.json");
const fixtureFile = path.join(root, "benchmarks", "fixtures", "context-retention-001.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("v0.1.2 benchmark control pins source, backend, model, and budgets", () => {
  const manifest = readJson(manifestFile);
  assert.equal(manifest.baseline.status, "frozen-control");
  assert.equal(manifest.baseline.tag, "v0.1.2");
  assert.match(manifest.baseline.gitCommit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.backend.buildInfo, "b10295-3db4ff877");
  assert.match(manifest.backend.chatTemplateSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.model.bytes, 15440519296);
  assert.match(manifest.model.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.agentConfig.contextWindow, 65536);
  assert.equal(manifest.agentConfig.maxOutputTokens, 8192);
  assert.equal(manifest.serverConfig.reasoningBudget, 4096);
  assert.deepEqual(manifest.agentConfig.thresholds, {
    garbageCollect: 0.55,
    prune: 0.65,
    semanticCompact: 0.72,
    hardTransfer: 0.8,
    failure: 0.9
  });
});

test("benchmark fixture hash and oracle are machine-checkable", () => {
  const manifest = readJson(manifestFile);
  const fixtureText = fs.readFileSync(fixtureFile);
  const fixtureHash = createHash("sha256").update(fixtureText).digest("hex");
  const fixture = JSON.parse(fixtureText.toString("utf8"));
  assert.equal(manifest.benchmark.fixtureSha256, fixtureHash);
  assert.equal(fixture.id, "context-retention-001");
  assert.ok(fixture.protectedFacts.length >= 2);
  assert.ok(fixture.protectedFacts.every((fact) => fact.id && fact.fact && fact.weight > 0 && fact.requiredUntil));
  const factIds = new Set(fixture.protectedFacts.map((fact) => fact.id));
  for (const checkpoint of fixture.checkpoints) {
    assert.ok(checkpoint.requiredFacts.every((id) => factIds.has(id)));
  }
});
