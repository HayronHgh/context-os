# Validated Transformation and Execution Contract

[Traditional Chinese](EXECUTION_CONTRACT.zh-TW.md) · English

Version: `0.2.0-dev.5`

Status: D0 execution protocol through D4 Post-transform Validation implemented. Mutation is absent.

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
Atomic Execution               (not implemented)
      ↓
ExecutionReport                (not implemented)
```

The current implementation stops at an immutable `ValidatedTransformation`. It approves a bound candidate for future execution but does not apply it.

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
| Future Executor | Can the validated candidate be applied atomically? |

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

D5 must receive both this validation and the original `TransformationCandidate`, then bind `sourceCandidateId` and digests before any commit. Failure returns `TRANSFORMATION_REJECTED`, `validatedTransformation: null`, and no partial approval.

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

The implementation is read-only except for ordinary test fixtures created in temporary directories.

## Remaining dev.5 sequence

```text
D5  Atomic Executor
D6  Inventory rebuild + actual re-tokenization + ExecutionReport
```

D5 is the first stage permitted to mutate active context. It must not treat `ValidatedTransformation` as self-contained replacement content.
