# Validated Transformation and Execution Contract

[Traditional Chinese](EXECUTION_CONTRACT.zh-TW.md) · English

Version: `0.2.0-dev.5`

Status: D0 execution protocol through D6 Post-commit Finalization implemented.

## Purpose

Dev.5 introduces a new trust boundary before ContextOS performs any destructive context operation:

```text
ValidatedPlan
      ↓
Execution Preflight
      ↓
ExecutablePlan
      ↓
Transformation Candidate
      ↓
Post-transform Validation
      ↓
Atomic Execution
      ↓
ExecutionResult
      ↓
Post-commit Finalization
      ↓
Inventory Rebuild + Canonical Re-estimation
      ↓
ExecutionReport
```

The current implementation stops after D6 returns an immutable finalized or finalization-failed `ExecutionReport`. D5 remains the only layer allowed to mutate the active message context; D6 performs derived observation, inventory synchronization, and canonical accounting without rollback authority.

## Core invariants

```text
ValidatedPlan != ExecutablePlan

M3 recoverability classification
!= execution-time recovery proof

COMPRESS authorization
!= authorization of arbitrary replacement content
```

The layers answer different questions:

| Layer | Question |
| --- | --- |
| M3 Validator | May this action be attempted under policy? |
| RecoveryVerifier | Is the Runtime recovery claim true now? |
| ExecutionPreflight | Is the complete current plan eligible to proceed? |
| Transformer | What candidate output could satisfy the authorized action? |
| Post-transform Validator | Is that candidate safe to hand to D5? |
| Atomic Executor | Can the exact validated candidate be applied atomically now? |

No later layer may reinterpret an earlier permission as broader authority.

## M4 frozen experiment identity

`config/m4-freeze.json` pins the `aa59f4d` baseline and SHA-256 hashes for:

- `planner-v1`;
- PlannerInventoryView selection and budgets;
- the M2 CompactionPlan protocol;
- the M3 authorization policy;
- PAR/IPR and Planner telemetry semantics.

`test/m4-freeze.test.js` fails if these inputs drift. A future prompt change requires a new identity such as `planner-v2`; it must not silently rewrite `planner-v1`.

The manifest also pins Qwen retry/binding behavior and semantic proposal orchestration because they determine experiment identity and telemetry meaning, even when the prompt text itself is unchanged.

## ExecutionPreflight admission gate

`preflightValidatedPlan()` accepts only a strict Runtime-produced `ValidatedPlan` that:

1. matches ValidatedPlan schema version 1 exactly;
2. is bound to the current inventory ID and fingerprint;
3. has exactly one decision for every current inventory unit;
4. has status `AUTHORIZED_POTENTIALLY_SUFFICIENT`;
5. has `fallbackRequired: false`;
6. contains no rejected decision;
7. has `actualReductionTokens: null`;
8. passes every required current-source recovery check.

An insufficient or rejected plan is not partially executable. Preflight does not cherry-pick apparently safe decisions from a failed plan.

## Recovery proof requirement

The Runtime asks for proof only when a destructive action carries a non-`none` recovery claim:

```text
COMPRESS | EXTERNALIZE | EVICT
and
recoverability != none
      ↓
current-source proof required
```

`COMPRESS` may be M3-authorized for some non-recoverable authorities. In that case the proof status is `NOT_REQUIRED` because no recovery claim exists; the future transformation output still requires independent post-transform validation before mutation.

`KEEP` and audit-only `PROMOTE_PROPOSAL` do not require recovery proof and cannot become destructive execution steps.

## RecoveryVerifier

`RecoveryVerifier` receives cloned unit/reference data and dispatches to one read-only provider by Runtime-owned recoverability type:

| Type | Required reference | Verification |
| --- | --- | --- |
| `artifact` | `artifactId` | artifact exists; stored content integrity is valid; optional reference SHA-256 matches |
| `repository` | project-relative `path` | real path remains inside project; file exists; current SHA-256 is measured; optional expected SHA-256 matches |
| `memory` | `stateKey` or `episodeId` | referenced durable state still exists |
| `rebuildable` | `mechanism` | named reconstruction mechanism is currently registered |
| `none` | none | no recovery claim to prove |

Provider absence, missing reference, path escape, missing source, integrity drift, invalid provider evidence, and thrown verification errors all fail closed.

A `RecoveryProof` is point-in-time admission evidence, not a lease and not a permanent capability. D5 must either rerun preflight immediately before commit or atomically compare fresh inventory/source bindings with the proof. An `ExecutablePlan` is single-use and must fail closed if those bindings have changed; it must not be cached for later execution.

## RecoveryProof

Every decision receives a deep-frozen proof result:

```ts
interface RecoveryProof {
  schemaVersion: 1;
  unitId: string;
  action: CompactionAction;
  sourceType: "artifact" | "repository" | "memory" | "rebuildable" | "none";
  checkedAt: string;
  status: "VERIFIED" | "NOT_REQUIRED" | "FAILED";
  code: RecoveryFailureCode | null;
  detail: string | null;
  evidence: object | null;
}
```

Proof evidence contains identifiers, hashes, sizes, paths, or mechanism names. It does not copy recovered content into the execution plan.

Machine-readable failure codes:

```text
RECOVERY_REFERENCE_MISSING
RECOVERY_PROVIDER_UNAVAILABLE
RECOVERY_SOURCE_NOT_FOUND
RECOVERY_SOURCE_INVALID
RECOVERY_INTEGRITY_MISMATCH
RECOVERY_VERIFICATION_FAILED
```

## ExecutablePlan

Only a fully successful preflight produces this distinct, deep-frozen object:

```ts
interface ExecutablePlan {
  schemaVersion: 1;
  executablePlanId: string;
  sourceValidatedPlanId: string;
  inventory: InventoryIdentity;
  status: "EXECUTABLE";
  decisions: Array<{
    unitId: string;
    action: CompactionAction;
    executionDisposition: "READY" | "NOOP" | "AUDIT_ONLY";
    importance: CompactionImportance | null;
    requestedTargetTokens: number | null;
    potentialReductionUpperBound: number;
    recoveryProof: RecoveryProof;
  }>;
  runtime: {
    checkedAt: string;
    requiredReductionTokens: number;
    potentialReductionUpperBound: number;
    actualReductionTokens: null;
    zeroMutation: true;
  };
}
```

It contains no replacement content, transformed messages, artifact writes, memory writes, mutation callback, or execution authority beyond the named decisions.

## D3 TransformationCandidate

`prepareTransformation()` performs a second exact inventory identity check before any model call, requires current Runtime content for every bound unit, and produces exactly one immutable candidate decision for every `ExecutablePlan` decision. Any stale identity, incomplete inventory, invalid plan, deterministic mapping error, or COMPRESS generation failure rejects the whole preparation. No partial candidate is returned.

Action mapping is fixed by Runtime:

| Action | Candidate operation | Model call |
| --- | --- | --- |
| `KEEP` | `NOOP` | no |
| `PROMOTE_PROPOSAL` | `AUDIT_ONLY` | no |
| `EVICT` | `REMOVE` | no |
| `EXTERNALIZE` | `REPLACE` with canonical recovery marker | no |
| `COMPRESS` | `REPLACE` with semantic candidate content | yes |

`REMOVE` and `REPLACE` describe a possible future transformation; they do not mutate active context. EXTERNALIZE markers are canonical Runtime output derived from the current unit recovery reference and its verified D2 proof. The model cannot author or alter recovery metadata.

Only COMPRESS enters the separately versioned `transformer-v1` path. Its payload contains only schema version, unit ID, kind, authority, target token request, and source content. The isolated request has no tools, disables thinking, uses independent input/output budgets and low temperature, and accepts strict JSON with exactly one field:

```json
{"content":"compressed candidate"}
```

Malformed JSON, schema violations, and empty output may receive one schema-only correction. Transport failure, budget failure, or repeated invalid output fails the whole plan. Candidate size is not an error in D3; D4 owns target and safety acceptance.

Runtime, never the model, computes SHA-256 over the complete source content and every replacement candidate. These bindings let D4/D5 prove that the reviewed content is the content later committed.

```ts
interface TransformationCandidate {
  schemaVersion: 1;
  candidateId: string;
  sourceExecutablePlanId: string;
  inventory: InventoryIdentity;
  status: "PREPARED";
  decisions: Array<{
    unitId: string;
    action: CompactionAction;
    operation: "NOOP" | "REMOVE" | "REPLACE" | "AUDIT_ONLY";
    sourceContentDigest: `sha256:${string}`;
    candidateContent: string | null;
    candidateContentDigest: `sha256:${string}` | null;
    requestedTargetTokens: number | null;
    candidateEstimatedTokens: number | null;
  }>;
  runtime: {
    generatedAt: string;
    zeroMutation: true;
    actualReductionTokens: null;
  };
}
```

Failure returns `TRANSFORMATION_FAILED` or `TRANSFORMATION_STALE_INVENTORY`, `candidate: null`, `zeroMutation: true`, and no partial decision list.

## D4 Post-transform Validation

`validateTransformation()` first performs complete Runtime-owned mechanical validation. The semantic validator is never called unless all of these checks pass:

1. candidate source ID exactly matches the `ExecutablePlan` ID;
2. candidate, executable plan, and current inventory identities match;
3. current inventory, executable decisions, and candidate decisions contain each unit exactly once;
4. every action, operation, and requested target matches the executable decision;
5. every source digest matches the current complete unit content;
6. every candidate digest and token estimate matches Runtime recomputation;
7. deterministic operation invariants and canonical EXTERNALIZE markers match exactly.

Fixed operation rules are:

| Action/operation | Required result |
| --- | --- |
| `KEEP / NOOP` | no candidate content, digest, or token estimate |
| `PROMOTE_PROPOSAL / AUDIT_ONLY` | no candidate content, digest, or token estimate |
| `EVICT / REMOVE` | no candidate content/digest; candidate tokens exactly zero |
| `EXTERNALIZE / REPLACE` | content exactly equals the Runtime-recomputed canonical recovery marker |
| `COMPRESS / REPLACE` | non-empty; estimated tokens positive, smaller than current source, and at or below requested target |

Only mechanically valid COMPRESS decisions enter isolated `transform-validator-v1`. Its model-facing payload contains original content, candidate content, kind, authority, and protected reasons. It has no tools, disables thinking, uses independent budgets and temperature, and returns only:

```json
{"verdict":"ACCEPT","reasonCodes":[]}
```

or a REJECT verdict with one or more of:

```text
CONSTRAINT_LOST
FACT_LOST
DECISION_LOST
IDENTIFIER_LOST
ERROR_STATE_LOST
UNRESOLVED_STATE_LOST
FABRICATION_ADDED
MEANING_CHANGED
```

The semantic model cannot modify candidate content, approve a mechanical failure, or widen execution authority. Any mechanical failure, semantic rejection, invalid semantic response, missing validator, or validator failure rejects the whole transformation.

Successful validation emits a deep-frozen object that intentionally does not duplicate candidate content:

```ts
interface ValidatedTransformation {
  schemaVersion: 1;
  validationId: string;
  sourceCandidateId: string;
  inventory: InventoryIdentity;
  status: "VALIDATED";
  decisions: Array<{
    unitId: string;
    action: CompactionAction;
    operation: "NOOP" | "REMOVE" | "REPLACE" | "AUDIT_ONLY";
    permission: "APPROVED";
    sourceContentDigest: `sha256:${string}`;
    candidateContentDigest: `sha256:${string}` | null;
    validatedCandidateTokens: number | null;
  }>;
  runtime: {
    validatedAt: string;
    zeroMutation: true;
    actualReductionTokens: null;
  };
}
```

D5 receives both this validation and the original `TransformationCandidate`, then binds `sourceCandidateId` and digests before any commit. D4 failure returns `TRANSFORMATION_REJECTED`, `validatedTransformation: null`, and no partial approval.

## D5 Atomic Executor

`AtomicExecutor.execute()` is deterministic and model-free. It requires:

```ts
{
  validatedTransformation,
  candidate,
  executablePlan,
  inventory,
  context: {
    messages,
    contextGeneration
  },
  recoveryVerifier,
  contextManager,
  tools
}
```

`ValidatedTransformation` is approval metadata, not an execution capability by itself. Before any mutation, Runtime requires this exact chain:

```text
validation.sourceCandidateId == candidate.candidateId
candidate.sourceExecutablePlanId == executablePlan.executablePlanId
validation.inventory == candidate.inventory
                     == executablePlan.inventory
                     == current inventory
```

Every current Context Unit must occur exactly once in Runtime-owned messages. Untracked Runtime messages, such as the ordinary system prompt, remain unchanged. For every tracked unit, Runtime recomputes the current source SHA-256 and compares it with both D3 and D4. Every REPLACE operation hashes the exact `candidate.candidateContent` again and compares it with the D3/D4 candidate digest.

### Fresh recovery and TOCTOU gate

D2 recovery proof is point-in-time evidence, not a lease. Immediately before commit, D5 reruns `RecoveryVerifier` for every destructive action:

```text
EVICT
EXTERNALIZE
COMPRESS
```

A D2 `VERIFIED` decision must still be `VERIFIED`; a legitimate no-recovery-claim decision must still be `NOT_REQUIRED`. Missing sources, provider failure, integrity drift, thrown verification, or changed classification aborts the entire execution.

The commit target exposes a monotonically increasing `contextGeneration`. D5 records both generation and the message-array reference before asynchronous recovery checks, then requires both to remain unchanged. It also reruns the complete chain and content bindings after the final `await`. Any drift returns `EXECUTION_STALE_CONTEXT`.

### Clone, build, validate, swap

D5 never edits the live array decision by decision. It applies every operation to a complete clone:

| Operation | Commit behavior |
| --- | --- |
| `NOOP` | Preserve the original message exactly |
| `AUDIT_ONLY` | Preserve the original message exactly; no memory write |
| `REMOVE` | Omit exactly the bound source message |
| `REPLACE` | Set content to the exact validated `candidate.candidateContent` |

The complete next context must preserve valid assistant tool-call/result structure. Only after clone/build and every pre-commit check succeeds does D5 synchronously replace the Runtime-owned message-array reference and increment `contextGeneration`. There is no `await` in this critical section.

Each `validationId` is single-use within its `AtomicExecutor`. In-flight reuse fails closed. Successful context commit and validation consumption occur in the same synchronous critical section; a second execution returns `EXECUTION_ALREADY_CONSUMED`.

### ExecutionResult

Success returns a deep-frozen result:

```ts
interface ExecutionResult {
  schemaVersion: 1;
  executionId: string;
  sourceValidationId: string;
  status: "COMMITTED";
  inventoryBefore: InventoryIdentity;
  operations: Array<{
    unitId: string;
    operation: "NOOP" | "REMOVE" | "REPLACE" | "AUDIT_ONLY";
  }>;
  potentialReductionUpperBound: number;
  committed: true;
  runtime: {
    committedAt: string;
    contextGenerationBefore: number;
    contextGenerationAfter: number;
    tokenAccountingBefore: TokenBreakdown;
    accountingToolsDigest: `sha256:${string}`;
  };
}
```

Failure returns `status: "EXECUTION_ABORTED"`, `committed: false`, an immutable diagnostic check list, and one or more bounded reason codes:

```text
INVALID_VALIDATED_TRANSFORMATION
EXECUTION_CHAIN_MISMATCH
EXECUTION_STALE_CONTEXT
SOURCE_CONTENT_CHANGED
CANDIDATE_CONTENT_CHANGED
RECOVERY_REVALIDATION_FAILED
EXECUTION_ALREADY_CONSUMED
EXECUTION_BUILD_FAILED
EXECUTION_COMMIT_FAILED
```

Executor failures never expose the prepared clone or partially apply an operation.

The pre-commit breakdown is an observation captured with `ContextManager.estimateComponents(messagesBefore, tools)`. It includes message serialization overhead, tool schemas/tool choice, and fixed prompt overhead. It does not grant mutation authority and does not claim actual reduction before commit.

## D6 Post-commit Finalization

`finalizeExecution()` accepts only `ExecutionResult.status == "COMMITTED"`. It requires the current `contextGeneration` to equal D5's `contextGenerationAfter`, the exact tool-envelope digest to match, and the existing Context Inventory registry to still have D5's `inventoryBefore` identity. Drift fails before any accounting claim.

D6 calls `ContextInventory.synchronize()` on the existing registry rather than creating a new one. Therefore:

- committed messages become the authoritative ACTIVE unit set;
- removed units become inactive (`EVICTED` or `EXTERNALIZED` according to recoverability);
- replacements retain their stable Context Unit ID;
- replacement content and token cost are refreshed;
- the new inventory ID/fingerprint reflects committed context.

Before and after token values use the same canonical estimator:

```text
before = ContextManager.estimateComponents(messagesBefore, tools)
after  = ContextManager.estimateComponents(committedMessages, tools)

actualReductionTokens = before.totalTokens - after.totalTokens
```

Tool tokens and fixed overhead must be identical on both sides. Actual reduction is signed and is never clamped: a larger canonical externalization marker correctly produces a negative value. `potentialReductionUpperBound` remains a separate M3 gross bound, not a substitute for observation.

Success returns:

```ts
interface ExecutionReport {
  schemaVersion: 1;
  reportId: string;
  sourceExecutionId: string;
  status: "FINALIZED";
  executionCommitted: true;
  inventoryBefore: InventoryIdentity;
  inventoryAfter: InventoryIdentity;
  tokens: {
    before: TokenBreakdown;
    after: TokenBreakdown;
    potentialReductionUpperBound: number;
    actualReductionTokens: number;
  };
  runtime: {
    finalizedAt: string;
    contextGeneration: number;
  };
}
```

Failure returns `EXECUTION_FINALIZATION_FAILED`, preserves `executionCommitted: true` for a valid D5 commit, and leaves `actualReductionTokens: null`. Reason codes are:

```text
INVALID_EXECUTION_RESULT
FINALIZATION_STALE_CONTEXT
FINALIZATION_INVENTORY_MISMATCH
INVENTORY_REBUILD_FAILED
ACCOUNTING_IDENTITY_MISMATCH
TOKEN_ACCOUNTING_FAILED
```

Finalization failure is not `EXECUTION_ABORTED`: D5 already committed, D6 never rolls it back, and no unverified actual-reduction claim is emitted.

## Failure result

Any gate failure returns:

```text
status: EXECUTION_PRECONDITION_FAILED
executablePlan: null
zeroMutation: true
```

Preflight reason codes include invalid shape, invalid or stale current inventory, insufficient/rejected plan, fallback requirement, decision/inventory mismatch, unauthorized decision, and recovery failure codes.

## Zero-mutation boundary

D0-D4 explicitly exclude:

- message or Context Unit mutation;
- artifact, project-memory, or episode writes;
- lifecycle or authority mutation;
- inventory rebuild;
- actual re-tokenization or actual-reduction claims.

These guarantees remain true through D4. D5 may replace only the active message-array reference after all gates pass. D6 may update the derived Context Inventory registry and accounting report, but performs no artifact, project-memory, episode, authority, or semantic-policy write.

Dev.5 stops at `ExecutionReport`. Its "actual" token reduction is the observed signed difference under ContextOS's frozen-compatible canonical estimator; it is not a claim of tokenizer-exact backend tokenization.
