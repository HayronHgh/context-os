# Compaction Authorization

[Traditional Chinese](COMPACTION_VALIDATION.zh-TW.md) · English

Version: `0.2.0-dev.4`

Status: M3 Runtime Validator remains frozen; M4 may call it, but transformation and execution are absent.

## Purpose

The Runtime Validator converts an untrusted `CompactionPlan` proposal into a distinct `ValidatedPlan`. A proposal is never permission. Validation is deterministic, model-free, side-effect-free, and stops before any context, artifact, lifecycle, authority, or memory mutation:

```text
CompactionPlan
      ↓
Runtime Validator
      ↓
ValidatedPlan
      ↓
STOP
```

The public module is `src/compaction-validator.js` and its entry point is:

```js
validateCompactionAuthorization({
  plan,
  inventory,
  pressure
})
```

`inventory` is the Runtime-owned snapshot to which the plan is bound. `pressure.requiredReductionTokens` is also Runtime-owned.

## ValidatedPlan

The Validator returns a fresh object and does not modify the plan or inventory:

```ts
interface ValidatedPlan {
  schemaVersion: 1;
  planId: string | null;
  inventory: { id: string; fingerprint: string } | null;
  status:
    | "AUTHORIZED_DEFINITELY_INSUFFICIENT"
    | "AUTHORIZED_POTENTIALLY_SUFFICIENT"
    | "REJECTED";
  reasonCodes: PlanReasonCode[];
  decisions: ValidatedDecision[];
  runtime: {
    requiredReductionTokens: number | null;
    potentialReductionUpperBound: number;
    actualReductionTokens: null;
    fallbackRequired: boolean;
  };
}

interface ValidatedDecision {
  unitId: string;
  proposedAction: CompactionAction;
  permission: "AUTHORIZED" | "REJECTED" | "AUDIT_ONLY";
  reasonCodes: DecisionReasonCode[];
  importance: "critical" | "high" | "medium" | "low" | null;
  requestedTargetTokens: number | null;
  potentialReductionUpperBound: number;
  replacementCostUnknown: boolean;
}
```

Rejected actions remain visible as rejected proposals. They are never silently rewritten to `KEEP`. Unmentioned units still materialize as implicit `KEEP` before authorization.

## Authorization precedence

The Runtime applies gates in this order:

```text
Protection
    ↓
Authority
    ↓
Recoverability
    ↓
Dependency closure
    ↓
Planner recommendation
```

Planner-provided `importance` is retained for audit only. It cannot override a Runtime gate.

### Protection

| Proposed action on a protected unit | Permission |
| --- | --- |
| `KEEP` | `AUTHORIZED` |
| `PROMOTE_PROPOSAL` | `AUDIT_ONLY` |
| `COMPRESS` | `REJECTED / PROTECTED_UNIT` |
| `EXTERNALIZE` | `REJECTED / PROTECTED_UNIT` |
| `EVICT` | `REJECTED / PROTECTED_UNIT` |

M3 has no safety-certified exception for protected-unit compression.

### Authority policy

`AUTHORIZATION_POLICY` is a frozen Runtime-owned table:

| Authority | KEEP | COMPRESS | EXTERNALIZE | EVICT |
| --- | --- | --- | --- | --- |
| `USER` | allow | allow when unprotected | require recoverable | require recoverable |
| `SOURCE_OF_TRUTH` | allow | allow when unprotected | require repository recovery | require recoverable |
| `EVIDENCE` | allow | require durable recovery | require recoverable | require durable recovery |
| `DERIVED` | allow | allow when unprotected | require recoverable | require recoverable |
| `SPECULATIVE` | allow | allow when unprotected | require recoverable | require recoverable |

`PROMOTE_PROPOSAL` is handled separately. It is always `AUDIT_ONLY / UNSUPPORTED_PROMOTION`; it does not write memory, change authority or lifecycle, or move active context.

### Recoverability

The exported predicates make the first policy explicit:

| Recoverability | `isRecoverable()` | `isDurablyRecoverable()` |
| --- | ---: | ---: |
| `artifact` | yes | yes |
| `repository` | yes | yes |
| `memory` | yes | yes |
| `rebuildable` | yes | no |
| `none` | no | no |

Rebuildable evidence is not durable exact-enough evidence. Therefore `EVIDENCE + rebuildable + EVICT` is rejected.

## Dependency safety

Only `depends_on` is a hard retention edge in M3. Validation performs graph work before action authorization:

```text
build graph
    ↓
validate targets
    ↓
detect cycles
    ↓
compute transitive closure
    ↓
authorize decisions
```

A missing target rejects the whole plan with `MISSING_DEPENDENCY`. A cycle rejects it with `DEPENDENCY_CYCLE`. Both require deterministic fallback.

Dependency safety is based on post-action availability, not prompt presence:

| Action | Availability |
| --- | --- |
| `KEEP` | `ACTIVE` |
| `COMPRESS` | `ACTIVE_TRANSFORMED` |
| `EXTERNALIZE` with recovery | `RECOVERABLE` |
| `EVICT` with recovery | `RECOVERABLE` |
| `EVICT` without recovery | `UNAVAILABLE` |
| `PROMOTE_PROPOSAL` | `ACTIVE` |

If an active unit directly or transitively requires a unit that a proposal would make unavailable, that target proposal is rejected with `ACTIVE_DEPENDENCY`. A recoverable externalized or evicted dependency remains available.

## Token accounting

M3 reports epistemically bounded values only:

```text
requiredReductionTokens
= Runtime requirement

potentialReductionUpperBound
= maximum gross reduction M3 can prove before execution

actualReductionTokens
= null
```

Per-action upper bounds are:

| Action | Potential upper bound |
| --- | ---: |
| `KEEP` | `0` |
| `PROMOTE_PROPOSAL` | `0` |
| `COMPRESS` | `unit.tokens - targetTokens` |
| `EXTERNALIZE` | `unit.tokens` gross upper bound |
| `EVICT` | `unit.tokens` gross upper bound |

`COMPRESS` is authorized only when `0 < targetTokens < unit.tokens`; otherwise it is rejected with `INVALID_COMPRESSION_TARGET`. `EXTERNALIZE` and `EVICT` set `replacementCostUnknown: true` because a later marker or recovery reference may consume tokens.

The plan status is:

| Condition | Status | Fallback |
| --- | --- | ---: |
| any plan or decision rejection | `REJECTED` | yes |
| authorized upper bound is below the Runtime requirement | `AUTHORIZED_DEFINITELY_INSUFFICIENT` | yes |
| authorized upper bound meets or exceeds the requirement | `AUTHORIZED_POTENTIALLY_SUFFICIENT` | no |

The final state never claims that reduction is actually sufficient. Only execution and post-transform measurement can establish actual savings.

## Reason codes

Plan-level codes:

```text
STALE_INVENTORY
UNKNOWN_UNIT
DUPLICATE_DECISION
MISSING_DEPENDENCY
DEPENDENCY_CYCLE
FAILURE_ENVELOPE_RISK
```

Decision-level codes:

```text
PROTECTED_UNIT
AUTHORITY_VIOLATION
NON_RECOVERABLE
ACTIVE_DEPENDENCY
UNSUPPORTED_PROMOTION
INVALID_ACTION
INVALID_COMPRESSION_TARGET
```

Malformed schemas and invalid Runtime pressure are contained as `FAILURE_ENVELOPE_RISK`. No exception escapes as permission.

## Purity and non-goals

Tests assert that repeated validation is deterministic and leaves plans, inventories, messages, project memory, episodes, and artifact observations unchanged. The Validator imports no model, llama.cpp client, memory store, tool evidence writer, or context executor.

M3 explicitly does not provide:

- replacement or summary content;
- context mutation;
- artifact creation;
- memory promotion or persistent writes;
- lifecycle or authority changes;
- model calls inside the Validator (M4 invokes it only after strict proposal binding);
- actual token-reduction measurement;
- changes to the frozen deterministic `context-manager.js` policy.

The next safe boundary remains authorization → future transformation → post-transform validation → execution.
