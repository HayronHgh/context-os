import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory-store.js";
import {
  RecoveryVerifier,
  createArtifactRecoveryProvider,
  createMemoryRecoveryProvider,
  createRebuildableRecoveryProvider,
  createRepositoryRecoveryProvider
} from "../src/recovery-verifier.js";

const fixedNow = () => new Date("2026-08-10T01:00:00.000Z");

function unit(overrides = {}) {
  return {
    id: "cu_recovery_000001",
    recoverability: "artifact",
    recoveryRef: { artifactId: "artifact-1" },
    ...overrides
  };
}

test("recovery proof is not required when no Runtime recovery claim exists", async () => {
  let calls = 0;
  const verifier = new RecoveryVerifier({
    providers: { artifact: async () => { calls += 1; } },
    now: fixedNow
  });
  const proof = await verifier.verify({
    unit: unit({ recoverability: "none", recoveryRef: null }),
    action: "COMPRESS"
  });
  assert.equal(proof.status, "NOT_REQUIRED");
  assert.equal(proof.checkedAt, "2026-08-10T01:00:00.000Z");
  assert.equal(calls, 0);
  assert.ok(Object.isFrozen(proof));
});

test("artifact provider proves current existence and integrity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-recovery-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = new MemoryStore(root).initialize();
  const artifact = memory.saveArtifact("exact evidence", "fixture");
  const verifier = new RecoveryVerifier({
    providers: { artifact: createArtifactRecoveryProvider(memory) },
    now: fixedNow
  });
  const current = unit({
    recoveryRef: { artifactId: artifact.id, sha256: artifact.sha256 }
  });
  const proof = await verifier.verify({ unit: current, action: "EVICT" });
  assert.equal(proof.status, "VERIFIED");
  assert.equal(proof.evidence.artifacts[0].artifactId, artifact.id);
  assert.equal(proof.evidence.artifacts[0].sha256, artifact.sha256);

  fs.writeFileSync(path.join(memory.artifactsDir, `${artifact.id}.txt`), "tampered", "utf8");
  const failed = await verifier.verify({ unit: current, action: "EVICT" });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.code, "RECOVERY_INTEGRITY_MISMATCH");
});

test("repository provider rejects path escape and hash drift", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-os-recovery-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "src.txt");
  fs.writeFileSync(source, "current source", "utf8");
  const provider = createRepositoryRecoveryProvider(root);
  const first = await provider({ recoveryRef: { path: "src.txt" } });
  assert.equal(first.verified, true);

  const verifier = new RecoveryVerifier({ providers: { repository: provider }, now: fixedNow });
  const verified = await verifier.verify({
    unit: unit({
      recoverability: "repository",
      recoveryRef: { path: "src.txt", sha256: first.evidence.sha256 }
    }),
    action: "EXTERNALIZE"
  });
  assert.equal(verified.status, "VERIFIED");
  fs.writeFileSync(source, "changed source", "utf8");
  const changed = await verifier.verify({
    unit: unit({
      recoverability: "repository",
      recoveryRef: { path: "src.txt", sha256: first.evidence.sha256 }
    }),
    action: "EXTERNALIZE"
  });
  assert.equal(changed.code, "RECOVERY_INTEGRITY_MISMATCH");

  const escaped = await verifier.verify({
    unit: unit({ recoverability: "repository", recoveryRef: { path: "../outside.txt" } }),
    action: "EXTERNALIZE"
  });
  assert.equal(escaped.code, "RECOVERY_SOURCE_INVALID");
});

test("memory and rebuildable providers verify only named current sources", async () => {
  const memory = {
    getState: () => ({ stateTransfer: "durable" }),
    listEpisodes: () => [{ id: "episode-1" }]
  };
  const verifier = new RecoveryVerifier({
    providers: {
      memory: createMemoryRecoveryProvider(memory),
      rebuildable: createRebuildableRecoveryProvider(new Map([["rerun-tests", () => {}]]))
    },
    now: fixedNow
  });
  const state = await verifier.verify({
    unit: unit({ recoverability: "memory", recoveryRef: { stateKey: "stateTransfer" } }),
    action: "EVICT"
  });
  assert.equal(state.status, "VERIFIED");
  const episode = await verifier.verify({
    unit: unit({ recoverability: "memory", recoveryRef: { episodeId: "episode-1" } }),
    action: "EVICT"
  });
  assert.equal(episode.status, "VERIFIED");
  const rebuild = await verifier.verify({
    unit: unit({ recoverability: "rebuildable", recoveryRef: { mechanism: "rerun-tests" } }),
    action: "EXTERNALIZE"
  });
  assert.equal(rebuild.status, "VERIFIED");

  const missing = await verifier.verify({
    unit: unit({ recoverability: "rebuildable", recoveryRef: { mechanism: "missing" } }),
    action: "EXTERNALIZE"
  });
  assert.equal(missing.code, "RECOVERY_SOURCE_NOT_FOUND");
});

test("missing references and providers fail closed without calling a source", async () => {
  const verifier = new RecoveryVerifier({ now: fixedNow });
  const missingReference = await verifier.verify({
    unit: unit({ recoveryRef: null }),
    action: "EVICT"
  });
  assert.equal(missingReference.code, "RECOVERY_REFERENCE_MISSING");
  const missingProvider = await verifier.verify({ unit: unit(), action: "EVICT" });
  assert.equal(missingProvider.code, "RECOVERY_PROVIDER_UNAVAILABLE");
});
