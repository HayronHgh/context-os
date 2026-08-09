import assert from "node:assert/strict";
import test from "node:test";
import { validateCompactionAuthorization } from "../src/compaction-validator.js";
import { ContextInventory } from "../src/context-inventory.js";
import { prepareTransformation } from "../src/context-transformer.js";
import { preflightValidatedPlan } from "../src/execution-preflight.js";
import { validateTransformation } from "../src/post-transform-validator.js";
import { RecoveryVerifier } from "../src/recovery-verifier.js";
import { contentDigest } from "../src/transformation-candidate.js";
import { estimateTokens } from "../src/utils.js";

const fixedNow = () => new Date("2026-08-10T06:00:00.000Z");
const sourceToCompress = "Constraint ALPHA remains. Identifier API_42 and path src/core.js are required. Error E_FAIL is unresolved. ".repeat(30);
const acceptedCompression = "Keep constraint ALPHA, identifier API_42, path src/core.js, and unresolved error E_FAIL.";

function unit({ id, authority, recoverability = "none", recoveryRef = null, content, tokenCost }) {
  return {
    id,
    kind: authority === "EVIDENCE" ? "TOOL_EVIDENCE" : "USER_CONTEXT",
    content,
    source: { type: "fixture" },
    authority,
    createdAt: "2026-08-10T00:00:00.000Z",
    taskId: "validation-task",
    recoverability,
    recoveryRef,
    protectedReasons: authority === "USER" ? ["EXPLICIT_USER_CONSTRAINT"] : [],
    dependencies: [],
    tokenCost,
    lifecycle: "ACTIVE"
  };
}

function currentInventory() {
  const runtime = new ContextInventory({ sessionId: "postvalidate" });
  runtime.register(unit({
    id: "cu_postvalidate_000001",
    authority: "USER",
    content: "Keep this requirement.",
    tokenCost: 100
  }));
  runtime.register(unit({
    id: "cu_postvalidate_000002",
    authority: "EVIDENCE",
    recoverability: "artifact",
    recoveryRef: { artifactId: "artifact-validation-1", sha256: "a".repeat(64) },
    content: "Durable evidence eligible for eviction.",
    tokenCost: 400
  }));
  runtime.register(unit({
    id: "cu_postvalidate_000003",
    authority: "SOURCE_OF_TRUTH",
    recoverability: "repository",
    recoveryRef: { path: "src/core.js", sha256: "b".repeat(64) },
    content: "Repository-backed source eligible for externalization.",
    tokenCost: 350
  }));
  runtime.register(unit({
    id: "cu_postvalidate_000004",
    authority: "DERIVED",
    content: sourceToCompress,
    tokenCost: estimateTokens(sourceToCompress)
  }));
  runtime.register(unit({
    id: "cu_postvalidate_000005",
    authority: "DERIVED",
    content: "Promotion stays audit-only.",
    tokenCost: 60
  }));
  return runtime.snapshot({ includeContent: true });
}

async function executable(inventory) {
  const plan = {
    schemaVersion: 1,
    planId: "plan_post_transform_validation",
    inventory: structuredClone(inventory.inventory),
    decisions: [
      { unitId: "cu_postvalidate_000002", action: "EVICT", importance: "low", reason: "durable" },
      { unitId: "cu_postvalidate_000003", action: "EXTERNALIZE", importance: "medium", reason: "repository" },
      { unitId: "cu_postvalidate_000004", action: "COMPRESS", targetTokens: 80, importance: "low", reason: "verbose" },
      { unitId: "cu_postvalidate_000005", action: "PROMOTE_PROPOSAL", importance: "medium", reason: "audit" }
    ]
  };
  const validatedPlan = validateCompactionAuthorization({
    plan,
    inventory,
    pressure: { requiredReductionTokens: 700 }
  });
  const verifier = new RecoveryVerifier({
    providers: {
      artifact: async ({ recoveryRef }) => ({ verified: true, evidence: { artifactId: recoveryRef.artifactId } }),
      repository: async ({ recoveryRef }) => ({ verified: true, evidence: { path: recoveryRef.path } })
    },
    now: fixedNow
  });
  return preflightValidatedPlan({ validatedPlan, inventory, recoveryVerifier: verifier, now: fixedNow });
}

async function prepared(inventory = currentInventory(), content = acceptedCompression) {
  const executablePlan = await executable(inventory);
  const transformer = { compress: async () => content };
  const candidate = await prepareTransformation({ executablePlan, inventory, transformer, now: fixedNow });
  return { inventory, executablePlan, candidate };
}

class FakeSemanticValidator {
  constructor(result = { verdict: "ACCEPT", reasonCodes: [] }) {
    this.result = result;
    this.calls = [];
  }

  async assess(input) {
    this.calls.push(structuredClone(input));
    if (this.result instanceof Error) throw this.result;
    return structuredClone(this.result);
  }
}

function replaceDecision(candidate, unitId, patch) {
  const mutated = structuredClone(candidate);
  Object.assign(mutated.decisions.find((decision) => decision.unitId === unitId), patch);
  return mutated;
}

test("D4 emits an immutable whole-plan ValidatedTransformation with zero mutation", async () => {
  const fixture = await prepared();
  const before = structuredClone(fixture);
  const semanticValidator = new FakeSemanticValidator();
  const validated = await validateTransformation({ ...fixture, semanticValidator, now: fixedNow });

  assert.equal(validated.status, "VALIDATED");
  assert.equal(validated.validationId, "validation_post_transform_validation");
  assert.equal(validated.sourceCandidateId, fixture.candidate.candidateId);
  assert.equal(validated.decisions.length, fixture.candidate.decisions.length);
  assert.ok(validated.decisions.every((decision) => decision.permission === "APPROVED"));
  assert.equal(validated.runtime.zeroMutation, true);
  assert.equal(validated.runtime.actualReductionTokens, null);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.decisions[0]));
  assert.equal(semanticValidator.calls.length, 1);
  assert.deepEqual(Object.keys(semanticValidator.calls[0]), [
    "schemaVersion",
    "originalContent",
    "candidateContent",
    "kind",
    "authority",
    "protectedReasons"
  ]);
  assert.deepEqual(fixture, before);
});

test("candidate, ExecutablePlan, and current inventory must bind exactly", async () => {
  const fixture = await prepared();
  const semanticValidator = new FakeSemanticValidator();
  const wrongSource = structuredClone(fixture.candidate);
  wrongSource.sourceExecutablePlanId = "exec_wrong_binding";
  const mismatch = await validateTransformation({
    ...fixture,
    candidate: wrongSource,
    semanticValidator,
    now: fixedNow
  });
  assert.deepEqual(mismatch.reasonCodes, ["CANDIDATE_EXECUTABLE_MISMATCH"]);

  const staleInventory = structuredClone(fixture.inventory);
  staleInventory.inventory.fingerprint = `sha256:${"0".repeat(64)}`;
  const stale = await validateTransformation({ ...fixture, inventory: staleInventory, semanticValidator, now: fixedNow });
  assert.deepEqual(stale.reasonCodes, ["TRANSFORMATION_STALE_INVENTORY"]);

  const incomplete = structuredClone(fixture.candidate);
  incomplete.decisions.pop();
  const coverage = await validateTransformation({ ...fixture, candidate: incomplete, semanticValidator, now: fixedNow });
  assert.deepEqual(coverage.reasonCodes, ["INVENTORY_DECISION_MISMATCH"]);
  assert.equal(semanticValidator.calls.length, 0);
});

test("Runtime recomputes source digest, candidate digest, and token estimate", async () => {
  const fixture = await prepared();
  const semanticValidator = new FakeSemanticValidator();
  const compressId = "cu_postvalidate_000004";

  const sourceMismatch = replaceDecision(fixture.candidate, compressId, {
    sourceContentDigest: `sha256:${"0".repeat(64)}`
  });
  const sourceResult = await validateTransformation({ ...fixture, candidate: sourceMismatch, semanticValidator, now: fixedNow });
  assert.ok(sourceResult.reasonCodes.includes("SOURCE_CONTENT_DIGEST_MISMATCH"));

  const contentMismatch = replaceDecision(fixture.candidate, compressId, {
    candidateContent: `${acceptedCompression} changed`
  });
  const digestResult = await validateTransformation({ ...fixture, candidate: contentMismatch, semanticValidator, now: fixedNow });
  assert.ok(digestResult.reasonCodes.includes("CANDIDATE_CONTENT_DIGEST_MISMATCH"));
  assert.ok(digestResult.reasonCodes.includes("CANDIDATE_TOKEN_ESTIMATE_MISMATCH"));

  const tokenMismatch = replaceDecision(fixture.candidate, compressId, {
    candidateEstimatedTokens: 999
  });
  const tokenResult = await validateTransformation({ ...fixture, candidate: tokenMismatch, semanticValidator, now: fixedNow });
  assert.ok(tokenResult.reasonCodes.includes("CANDIDATE_TOKEN_ESTIMATE_MISMATCH"));
  assert.equal(semanticValidator.calls.length, 0);
});

test("NOOP, AUDIT_ONLY, REMOVE, and EXTERNALIZE rules are deterministic", async () => {
  const fixture = await prepared();
  const semanticValidator = new FakeSemanticValidator();
  const mutated = structuredClone(fixture.candidate);
  const noop = mutated.decisions.find((decision) => decision.action === "KEEP");
  noop.candidateContent = "illegal";
  noop.candidateContentDigest = contentDigest(noop.candidateContent);
  noop.candidateEstimatedTokens = estimateTokens(noop.candidateContent);
  const audit = mutated.decisions.find((decision) => decision.action === "PROMOTE_PROPOSAL");
  audit.candidateContent = "illegal";
  audit.candidateContentDigest = contentDigest(audit.candidateContent);
  audit.candidateEstimatedTokens = estimateTokens(audit.candidateContent);
  const remove = mutated.decisions.find((decision) => decision.action === "EVICT");
  remove.candidateEstimatedTokens = 1;
  const marker = mutated.decisions.find((decision) => decision.action === "EXTERNALIZE");
  marker.candidateContent = "[context-os:externalized forged]";
  marker.candidateContentDigest = contentDigest(marker.candidateContent);
  marker.candidateEstimatedTokens = estimateTokens(marker.candidateContent);

  const result = await validateTransformation({ ...fixture, candidate: mutated, semanticValidator, now: fixedNow });
  assert.ok(result.reasonCodes.includes("INVALID_NOOP_CANDIDATE"));
  assert.ok(result.reasonCodes.includes("INVALID_AUDIT_ONLY_CANDIDATE"));
  assert.ok(result.reasonCodes.includes("INVALID_REMOVE_CANDIDATE"));
  assert.ok(result.reasonCodes.includes("INVALID_EXTERNALIZE_MARKER"));
  assert.equal(result.validatedTransformation, null);
  assert.equal(semanticValidator.calls.length, 0);
});

test("COMPRESS must be non-empty, reduce tokens, and satisfy its target", async () => {
  const fixture = await prepared();
  const semanticValidator = new FakeSemanticValidator();
  const compressId = "cu_postvalidate_000004";

  const empty = replaceDecision(fixture.candidate, compressId, {
    candidateContent: "",
    candidateContentDigest: contentDigest(""),
    candidateEstimatedTokens: estimateTokens("")
  });
  const emptyResult = await validateTransformation({ ...fixture, candidate: empty, semanticValidator, now: fixedNow });
  assert.ok(emptyResult.reasonCodes.includes("EMPTY_COMPRESSION_CANDIDATE"));

  const unchanged = replaceDecision(fixture.candidate, compressId, {
    candidateContent: sourceToCompress,
    candidateContentDigest: contentDigest(sourceToCompress),
    candidateEstimatedTokens: estimateTokens(sourceToCompress)
  });
  const unchangedResult = await validateTransformation({ ...fixture, candidate: unchanged, semanticValidator, now: fixedNow });
  assert.ok(unchangedResult.reasonCodes.includes("COMPRESSION_NOT_REDUCED"));

  const oversizeText = "Reduced but still over the requested target. ".repeat(10);
  assert.ok(estimateTokens(oversizeText) > 80);
  assert.ok(estimateTokens(oversizeText) < estimateTokens(sourceToCompress));
  const oversize = replaceDecision(fixture.candidate, compressId, {
    candidateContent: oversizeText,
    candidateContentDigest: contentDigest(oversizeText),
    candidateEstimatedTokens: estimateTokens(oversizeText)
  });
  const oversizeResult = await validateTransformation({ ...fixture, candidate: oversize, semanticValidator, now: fixedNow });
  assert.deepEqual(oversizeResult.reasonCodes, ["TARGET_TOKEN_EXCEEDED"]);
  assert.equal(semanticValidator.calls.length, 0);
});

test("semantic rejection rejects the whole transformation and cannot modify candidate", async () => {
  const fixture = await prepared();
  const before = structuredClone(fixture.candidate);
  const semanticValidator = new FakeSemanticValidator({
    verdict: "REJECT",
    reasonCodes: ["CONSTRAINT_LOST", "IDENTIFIER_LOST"]
  });
  const result = await validateTransformation({ ...fixture, semanticValidator, now: fixedNow });
  assert.equal(result.status, "TRANSFORMATION_REJECTED");
  assert.deepEqual(result.reasonCodes, ["CONSTRAINT_LOST", "IDENTIFIER_LOST"]);
  assert.equal(result.validatedTransformation, null);
  assert.deepEqual(fixture.candidate, before);

  const invalidValidator = new FakeSemanticValidator({ verdict: "ACCEPT", reasonCodes: ["FACT_LOST"] });
  const invalid = await validateTransformation({ ...fixture, semanticValidator: invalidValidator, now: fixedNow });
  assert.deepEqual(invalid.reasonCodes, ["SEMANTIC_VALIDATION_FAILED"]);
});

test("missing or failed semantic validator rejects without any Runtime mutation", async () => {
  const fixture = await prepared();
  const before = structuredClone(fixture);
  const unavailable = await validateTransformation({ ...fixture, now: fixedNow });
  assert.deepEqual(unavailable.reasonCodes, ["SEMANTIC_VALIDATOR_UNAVAILABLE"]);

  const error = new Error("validator unavailable");
  error.code = "SEMANTIC_VALIDATION_FAILED";
  const failed = await validateTransformation({
    ...fixture,
    semanticValidator: new FakeSemanticValidator(error),
    now: fixedNow
  });
  assert.deepEqual(failed.reasonCodes, ["SEMANTIC_VALIDATION_FAILED"]);
  assert.equal(failed.runtime.actualReductionTokens, null);
  assert.deepEqual(fixture, before);
});
