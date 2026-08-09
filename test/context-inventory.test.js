import test from "node:test";
import assert from "node:assert/strict";
import {
  ContextUnitIdFactory,
  createContextUnit
} from "../src/context-unit.js";
import { ContextInventory } from "../src/context-inventory.js";
import { serializeContext } from "../src/context-messages.js";

const fixedNow = () => new Date("2026-08-09T00:00:00.000Z");

test("Context Unit IDs use a stable session prefix and monotonic sequence", () => {
  const factory = new ContextUnitIdFactory("sessionA");
  assert.equal(factory.next(), "cu_sessionA_000001");
  assert.equal(factory.next(), "cu_sessionA_000002");
});

test("Context Unit validates authority, artifact recovery, and dependency shape", () => {
  const factory = new ContextUnitIdFactory("validation");
  const evidence = createContextUnit({
    kind: "TOOL_EVIDENCE",
    content: "exact evidence",
    source: { type: "tool", name: "run_command" },
    authority: "EVIDENCE",
    recoverability: "artifact",
    recoveryRef: { artifactId: "artifact-1", sha256: "a".repeat(64) },
    protectedReasons: [],
    dependencies: []
  }, { idFactory: factory, now: fixedNow });
  assert.equal(evidence.id, "cu_validation_000001");
  assert.equal(evidence.authority, "EVIDENCE");
  assert.equal(evidence.recoverability, "artifact");
  assert.throws(() => createContextUnit({
    ...evidence,
    id: "cu_validation_000002",
    authority: "IMPORTANT"
  }), /authority must be one of/);
  assert.throws(() => createContextUnit({
    ...evidence,
    id: "cu_validation_000002",
    recoveryRef: null
  }), /requires recoveryRef\.artifactId/);
});

test("inventory identity survives reorder and structured rebuild", () => {
  const inventory = new ContextInventory({ sessionId: "stable", now: fixedNow });
  const first = { role: "user", content: "Do not change the public API" };
  const second = { role: "assistant", content: "I will inspect it." };
  inventory.synchronize([first, second]);
  const firstId = first.context_os.contextUnitId;
  const secondId = second.context_os.contextUnitId;

  const rebuilt = structuredClone([second, first]);
  inventory.synchronize(rebuilt);
  assert.equal(rebuilt[0].context_os.contextUnitId, secondId);
  assert.equal(rebuilt[1].context_os.contextUnitId, firstId);
  assert.equal(inventory.snapshot().stats.totalUnits, 2);
});

test("rebuild reserves existing sequences before assigning new IDs", () => {
  const inventory = new ContextInventory({ sessionId: "reserve", now: fixedNow });
  const existing = {
    role: "user",
    content: "existing",
    context_os: {
      contextUnitId: "cu_reserve_000127",
      contextUnitCreatedAt: "2026-08-09T00:00:00.000Z"
    }
  };
  const fresh = { role: "assistant", content: "new" };
  inventory.synchronize([fresh, existing]);
  assert.equal(fresh.context_os.contextUnitId, "cu_reserve_000128");
  assert.equal(existing.context_os.contextUnitId, "cu_reserve_000127");
});

test("latest user protection is runtime-owned and authority remains independent", () => {
  const inventory = new ContextInventory({ sessionId: "authority", now: fixedNow });
  const messages = [
    { role: "user", content: "old context" },
    { role: "assistant", content: "answer" },
    {
      role: "user",
      content: "public API must remain compatible",
      context_os: {
        contextUnit: {
          kind: "USER_REQUIREMENT",
          authority: "USER",
          recoverability: "none",
          protectedReasons: ["EXPLICIT_USER_CONSTRAINT"]
        }
      }
    }
  ];
  const snapshot = inventory.synchronize(messages);
  const requirement = snapshot.units.find((unit) => unit.kind === "USER_REQUIREMENT");
  assert.equal(requirement.authority, "USER");
  assert.deepEqual(requirement.protectedReasons.sort(), ["EXPLICIT_USER_CONSTRAINT", "LATEST_USER_TURN"]);
  assert.equal(Object.hasOwn(requirement, "importance"), false);
});

test("durable evidence is recoverable while non-durable evidence is protected", () => {
  const inventory = new ContextInventory({ sessionId: "evidence", now: fixedNow });
  const messages = [
    {
      role: "tool",
      name: "read_file",
      tool_call_id: "call-1",
      content: "file content",
      context_os: {
        durable: true,
        recoveryType: "artifact",
        artifactId: "read-file-artifact",
        sha256: "b".repeat(64),
        unitKind: "FILE_SNAPSHOT",
        resultStatus: "ok"
      }
    },
    {
      role: "tool",
      name: "run_command",
      tool_call_id: "call-2",
      content: "small transient result",
      context_os: { durable: false, recoveryType: "context-only", resultStatus: "ok" }
    }
  ];
  const snapshot = inventory.synchronize(messages);
  const file = snapshot.units.find((unit) => unit.kind === "FILE_SNAPSHOT");
  const transient = snapshot.units.find((unit) => unit.source.tool === "run_command");
  assert.equal(file.recoverability, "artifact");
  assert.equal(file.recoveryRef.artifactId, "read-file-artifact");
  assert.equal(transient.recoverability, "none");
  assert.deepEqual(transient.protectedReasons, ["NON_RECOVERABLE_EVIDENCE"]);
});

test("failed tool observations are unresolved protected errors", () => {
  const inventory = new ContextInventory({ sessionId: "errors", now: fixedNow });
  const message = {
    role: "tool",
    name: "run_command",
    tool_call_id: "call-error",
    content: "command failed",
    context_os: { resultStatus: "error", durable: false, recoveryType: "context-only" }
  };
  const snapshot = inventory.synchronize([message]);
  assert.equal(snapshot.units[0].kind, "ERROR");
  assert.deepEqual(snapshot.units[0].protectedReasons, ["UNRESOLVED_ERROR"]);
});

test("custom descriptors cannot clear Runtime-owned protection", () => {
  const inventory = new ContextInventory({ sessionId: "runtime-protection", now: fixedNow });
  const message = {
    role: "tool",
    name: "run_command",
    tool_call_id: "call-error",
    content: "command failed",
    context_os: {
      resultStatus: "error",
      durable: false,
      recoveryType: "context-only",
      contextUnit: {
        kind: "ERROR",
        authority: "EVIDENCE",
        recoverability: "none",
        protectedReasons: []
      }
    }
  };
  const snapshot = inventory.synchronize([message]);
  assert.deepEqual(snapshot.units[0].protectedReasons, ["UNRESOLVED_ERROR"]);
});

test("externalized exchange markers become artifact-backed memory references", () => {
  const inventory = new ContextInventory({ sessionId: "markers", now: fixedNow });
  const message = {
    role: "assistant",
    content: "[older tool exchange externalized]",
    context_os: {
      kind: "externalized-tool-exchange",
      recoveryReferences: [
        { artifactId: "artifact-1", tool: "read_file" },
        { artifactId: "artifact-2", tool: "grep_search" }
      ]
    }
  };
  const snapshot = inventory.synchronize([message]);
  assert.equal(snapshot.units[0].kind, "MEMORY_REFERENCE");
  assert.equal(snapshot.units[0].authority, "DERIVED");
  assert.equal(snapshot.units[0].recoverability, "artifact");
  assert.deepEqual(snapshot.units[0].recoveryRef.artifactIds, ["artifact-1", "artifact-2"]);
});

test("inventory lifecycle distinguishes externalized from unrecoverable eviction", () => {
  const inventory = new ContextInventory({ sessionId: "lifecycle", now: fixedNow });
  const durable = {
    role: "tool",
    name: "read_file",
    tool_call_id: "durable",
    content: "durable",
    context_os: {
      durable: true,
      recoveryType: "artifact",
      artifactId: "artifact-durable",
      resultStatus: "ok"
    }
  };
  const user = { role: "user", content: "volatile" };
  inventory.synchronize([durable, user]);
  const durableId = durable.context_os.contextUnitId;
  const userId = user.context_os.contextUnitId;
  inventory.synchronize([]);
  assert.equal(inventory.get(durableId).lifecycle, "EXTERNALIZED");
  assert.equal(inventory.get(userId).lifecycle, "EVICTED");
});

test("dependency validation fails closed on missing unit references", () => {
  const inventory = new ContextInventory({ sessionId: "dependencies", now: fixedNow });
  inventory.register({
    kind: "DECISION",
    content: "Keep the public API",
    source: { type: "runtime" },
    authority: "DERIVED",
    recoverability: "memory",
    protectedReasons: ["ACTIVE_DECISION"],
    dependencies: [{ unitId: "cu_dependencies_999999", relation: "depends_on" }]
  });
  const validation = inventory.validateDependencies();
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /missing Context Unit/);
});

test("inventory metadata remains behind the model serialization boundary", () => {
  const inventory = new ContextInventory({ sessionId: "wire", now: fixedNow });
  const message = { role: "user", content: "hello" };
  inventory.synchronize([message]);
  assert.ok(message.context_os.contextUnitId);
  assert.deepEqual(serializeContext([message]), [{ role: "user", content: "hello" }]);
});
