import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeSession } from "../src/runtime-session.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

test("RuntimeSession owns one runtime and publishes a replayable turn trace", async () => {
  let hooks;
  const session = new RuntimeSession({
    id: "session-test",
    projectRoot: "C:\\repo",
    runtimeFactory: ({ confirm, onEvent }) => {
      hooks = { confirm, onEvent };
      return {
        async runTurn(content) {
          onEvent({ type: "tool_start", name: "read_file" });
          onEvent({ type: "tool_end", name: "read_file", ok: true });
          onEvent({ type: "assistant", content: `Evidence: ${content}` });
          return { content: `Evidence: ${content}`, usage: { total_tokens: 42 } };
        }
      };
    }
  });

  assert.equal(typeof hooks.confirm, "function");
  const live = [];
  const unsubscribe = session.subscribe((event) => live.push(event));
  const result = await session.runTurn("inspect");
  unsubscribe();

  assert.equal(result.content, "Evidence: inspect");
  assert.deepEqual(live.map((event) => event.type), [
    "session_ready", "turn_start", "tool_start", "tool_end", "assistant", "turn_complete"
  ]);
  assert.equal(live.find((event) => event.type === "turn_start").data.content, "inspect");
  assert.equal(session.snapshot().busy, false);

  const replay = [];
  session.subscribe((event) => replay.push(event.type), { afterEventId: 3 })();
  assert.deepEqual(replay, ["tool_end", "assistant", "turn_complete"]);
});

test("RuntimeSession bridges an approval decision back into the tool runner", async () => {
  let confirm;
  const session = new RuntimeSession({
    projectRoot: "C:\\repo",
    runtimeFactory: (hooks) => {
      confirm = hooks.confirm;
      return { runTurn: async () => ({ content: "" }) };
    }
  });

  const decision = confirm("write_file: src/example.js");
  const event = session.history.find((entry) => entry.type === "approval_required");
  assert.ok(event.data.approvalId);
  assert.equal(event.data.description, "write_file: src/example.js");
  assert.equal(session.resolveApproval(event.data.approvalId, true), true);
  assert.equal(await decision, true);
  assert.equal(session.resolveApproval(event.data.approvalId, false), false);
  assert.equal(session.snapshot().pendingApprovals, 0);
});

test("RuntimeSession approval timeout fails closed", async () => {
  let confirm;
  const session = new RuntimeSession({
    projectRoot: "C:\\repo",
    approvalTimeoutMs: 5,
    runtimeFactory: (hooks) => {
      confirm = hooks.confirm;
      return { runTurn: async () => ({ content: "" }) };
    }
  });

  assert.equal(await confirm("run command: npm test"), false);
  const resolved = session.history.find((entry) => entry.type === "approval_resolved");
  assert.equal(resolved.data.approved, false);
  assert.equal(resolved.data.source, "timeout");
});

test("RuntimeSession rejects overlapping turns", async () => {
  const gate = deferred();
  const session = new RuntimeSession({
    projectRoot: "C:\\repo",
    runtimeFactory: () => ({ runTurn: () => gate.promise })
  });
  const first = session.runTurn("first");
  await assert.rejects(() => session.runTurn("second"), { code: "SESSION_BUSY" });
  gate.resolve({ content: "done" });
  await first;
});

test("closing a RuntimeSession denies pending approvals", async () => {
  let confirm;
  const session = new RuntimeSession({
    projectRoot: "C:\\repo",
    runtimeFactory: (hooks) => {
      confirm = hooks.confirm;
      return { runTurn: async () => ({ content: "" }) };
    }
  });
  const decision = confirm("edit_file: README.md");
  session.close();
  assert.equal(await decision, false);
  await assert.rejects(() => session.runTurn("after close"), { code: "SESSION_CLOSED" });
});

test("RuntimeSession replay history is bounded by count and serialized bytes", () => {
  const session = new RuntimeSession({
    projectRoot: "C:\\repo",
    runtimeFactory: () => ({ runTurn: async () => ({ content: "" }) })
  });
  for (let index = 0; index < 30; index += 1) session.publish("large", { content: "x".repeat(100_000), index });
  assert.ok(session.history.length < 30);
  assert.ok(session.historyBytes <= 2 * 1024 * 1024);
  assert.equal(session.history.at(-1).data.index, 29);
});
