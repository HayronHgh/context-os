import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config", "m4-freeze.json"), "utf8"));

function sha256(file) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

test("dev.5 preserves the frozen M4 experiment identity", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.baselineCommit, "aa59f4d496950ba069cb7273d4096cc1223d5dcf");
  assert.equal(manifest.promptVersion, "planner-v1");
  for (const [relative, expected] of Object.entries(manifest.immutableInputs)) {
    assert.equal(sha256(path.join(root, relative)), expected, `${relative} changed after M4 freeze`);
  }
});
