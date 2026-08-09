# RFC-001: Adaptive Semantic Context Planning

- Status: Accepted for staged implementation
- Target: v0.2.0
- Baseline: `v0.1.2` at `ff2944581c7dd6200a170bc0bd94128e58ffd533`
- Companion: [Traditional Chinese](RFC-001-ADAPTIVE-CONTEXT-PLANNING.zh-TW.md)

## Summary

ContextOS v0.2.0 studies how a local coding agent can make task-aware context decisions without weakening the deterministic safety envelope frozen in v0.1.2.

The governing rule is:

> **Token pressure determines when ContextOS should intervene; task semantics determine what information should be preserved or transformed; Runtime invariants determine which proposed actions are legal.**

These are three separate layers:

```text
Token Pressure     -> when intervention may be required
Semantic Planner   -> what appears relevant to the current task
Runtime Validator  -> which proposed actions are permitted
```

The Planner proposes. It never directly deletes context, changes authority, removes protection, or writes persistent memory.

## Decision

v0.2.0 will be developed in six milestones. M0 freezes a reproducible v0.1.2 control. M1 introduces an observational Context Inventory. Planner and Validator protocols are added only after the inventory model is testable. Qwen integration comes after fake-plan validation. The default policy is selected only after deterministic, semantic, and hybrid variants are benchmarked under the same safety envelope.

v0.2.0 is not allowed to weaken any v0.1.2 invariant.

## Motivation

An OpenAI message is a transport unit, not necessarily an information unit. One assistant message may contain a hypothesis, a plan, and tool calls. One command result may contain thousands of noisy lines and three decisive errors. Message-level FIFO or threshold-only deletion cannot express these differences.

At the same time, unconstrained model-directed memory management is unsafe. A model can misjudge an explicit user constraint as unimportant, discard evidence that supports an unresolved hypothesis, or promote speculation into durable project memory. Semantic judgment therefore cannot itself be permission.

## Non-goals

This RFC does not introduce:

- AST, LSP, Git graph, or repository graph intelligence;
- vector retrieval or a new memory database;
- multi-agent planning;
- model-executed persistent-memory promotion;
- replacement of the v0.1.2 pressure thresholds;
- a guarantee that the first Context Unit extractor is semantically complete.

## Frozen safety envelope

The Planner operates below the v0.1.2 invariants:

1. Repository files remain the mutable source of truth.
2. Required task state survives a conversation reset.
3. State Transfer remains derived continuation state, not authority.
4. Deterministic tool-evidence eviction requires a durable recovery path.
5. Invalid compaction output cannot replace valid history.
6. File and artifact tools remain inside the selected project root.
7. Pressure handling cannot silently exceed the configured envelope.
8. Corrupted auxiliary memory cannot hide unrelated valid memory.

No plan can bypass durability, authority, path containment, fail-loud behavior, or context safety.

## M0: frozen benchmark control

The control is the annotated `v0.1.2` tag, not the former PR head. Its manifest is [benchmarks/baselines/v0.1.2.json](../../benchmarks/baselines/v0.1.2.json). It records:

- resolved ContextOS commit and source blob fingerprints;
- exact llama.cpp build and chat-template SHA-256;
- exact GGUF filename, byte count, and SHA-256;
- server, context, output, reasoning, and pressure settings;
- host CPU/GPU and runtime versions;
- the first exact fixture and oracle;
- the A/B/C variants and initial metrics.

The control is immutable for comparative results. Later 0.1.x security or correctness fixes must receive a new baseline identity rather than silently changing this one.

## M1: Context Unit

The runtime introduces the following semantic record:

```ts
interface ContextUnit {
  id: string;
  kind: ContextUnitKind;
  content: string;
  source: { type: string; [key: string]: unknown };
  authority: Authority;
  createdAt: string;
  taskId: string | null;
  recoverability: Recoverability;
  recoveryRef: object | null;
  protectedReasons: ProtectedReason[];
  dependencies: Dependency[];
  tokenCost: number;
  lifecycle: Lifecycle;
}
```

Initial kinds are intentionally limited:

```text
USER_REQUIREMENT  USER_CONTEXT
DECISION          HYPOTHESIS
ERROR             TEST_RESULT
TOOL_EVIDENCE     FILE_SNAPSHOT
REASONING         PLAN
STATE_TRANSFER    MEMORY_REFERENCE
```

The first runtime extractor is conservative. It deterministically inventories user, assistant, tool, and State Transfer messages. It supports explicit descriptors for finer units, but it does not ask a model to classify them and does not change compaction policy.

### Stable identity

IDs use a session prefix and monotonic sequence:

```text
cu_<session-prefix>_<sequence>
cu_01J8ABC_000127
```

Identity is not position. Reordering, cloning, pruning, or rebuilding a context does not change an existing ID. The ID and creation time live in internal `context_os` metadata and are removed by the model serialization boundary.

### Authority is not importance

Authority represents the trust or constraint position of information:

| Authority | Meaning |
| --- | --- |
| `USER` | User-authored requirement or context |
| `SOURCE_OF_TRUTH` | Current mutable repository state |
| `EVIDENCE` | Runtime/tool observation |
| `DERIVED` | State Transfer, summary, or runtime conclusion |
| `SPECULATIVE` | Model reasoning or hypothesis |

Importance will be a Planner judgment about current task relevance. A low-importance `USER` requirement does not become evictable merely because the Planner says it is low. Importance never upgrades authority.

### Recoverability

Initial values are:

```text
none  artifact  repository  memory  rebuildable
```

Artifact recoverability requires an artifact ID. A reference without a verified recovery path is not recoverability. Lifecycle values distinguish `ACTIVE`, `RESOLVED`, `SUPERSEDED`, `EXTERNALIZED`, and `EVICTED` units for observation and later validation.

### Runtime-owned protection

The initial protection vocabulary is:

```text
EXPLICIT_USER_CONSTRAINT
LATEST_USER_TURN
UNRESOLVED_ERROR
UNRESOLVED_HYPOTHESIS
ACTIVE_DECISION
UNVERIFIED_MODIFICATION
NON_RECOVERABLE_EVIDENCE
DEPENDENCY_ROOT
```

The Runtime creates and removes protection from deterministic state and events. The Planner may claim that an item appears resolved, but cannot clear protection. M1 already marks the latest user turn, failed tool evidence, and non-recoverable evidence conservatively.

### Dependencies

M1 uses a small typed edge set, not a general knowledge graph:

```ts
type Relation = "supports" | "contradicts" | "depends_on" | "supersedes";
```

References must use stable Context Unit IDs, cannot point to self, and must validate against the inventory before a plan can be authorized.

## Inventory protocol

The Planner will receive a bounded inventory rather than an unstructured 50K-token transcript:

```json
{
  "pressure": { "ratio": 0.71, "requiredReductionTokens": 9000 },
  "task": { "objective": "...", "phase": "investigation" },
  "stats": { "totalUnits": 12, "totalTokens": 18500 },
  "units": [
    {
      "id": "cu_session_000127",
      "kind": "USER_REQUIREMENT",
      "tokens": 143,
      "authority": "USER",
      "recoverability": "none",
      "protected": true,
      "protectedReasons": ["EXPLICIT_USER_CONSTRAINT"],
      "summary": "Do not change the public API"
    }
  ]
}
```

M1 inventory output excludes full content by default, includes bounded summaries, and remains behind the OpenAI-compatible serialization boundary. `/inventory` exists for inspection. No Planner consumes it yet.

## M2: Planner protocol — implemented in `0.2.0-dev.2`

The `CompactionPlan` action vocabulary is:

```text
KEEP
COMPRESS
EXTERNALIZE
EVICT
PROMOTE_PROPOSAL
```

Every decision identifies a stable unit ID, action, task-relative importance, and concise reason. `COMPRESS` may request a positive `targetTokens`, but cannot supply replacement content. Planner-provided authority, protection, recoverability, lifecycle, promotion content, and expected savings are outside the schema.

Every plan is bound to a canonical inventory ID and SHA-256 fingerprint. The fingerprint covers position, stable identity, content digest, kind, source, task, authority, lifecycle, protection, recoverability, dependencies, and token cost. A mismatch or a unit added after planning rejects the whole plan as stale. Unmentioned units default to `KEEP`.

`FakePlanner` and fixed valid/invalid fixtures exercise the protocol without Qwen. M2 stops after strict parsing, snapshot binding, and default expansion. It cannot authorize, execute, transform, externalize, evict, or persist anything.

`PROMOTE_PROPOSAL` is audit-only in v0.2.0 Phase A/B. It never writes project memory. Promotion is more dangerous than eviction because an incorrect speculation can poison future sessions while appearing authoritative. See the [CompactionPlan Protocol](../COMPACTION_PLAN_PROTOCOL.md) for the exact implementation contract.

## M3: Runtime Validator — implemented in 0.2.0-dev.3

The Validator converts proposals into a distinct permission type. It never edits the Planner plan in place and never silently rewrites a rejected action to `KEEP`. Each result retains proposed action, permission, and machine-readable reason.

Authorization precedence is fixed:

```text
Runtime protection
  > authority
  > recoverability
  > dependency closure
  > Planner importance/recommendation
```

### Protection

In the first Validator, any protected unit permits only `KEEP`. `COMPRESS`, `EXTERNALIZE`, and `EVICT` are rejected. `PROMOTE_PROPOSAL` is `AUDIT_ONLY` while the active copy remains kept. Safety-certified compression of protected units is out of scope.

### Authority and recoverability

Protection is evaluated before this matrix:

| Authority | KEEP | COMPRESS | EXTERNALIZE | EVICT |
| --- | ---: | ---: | ---: | ---: |
| `USER` | allow | only when unprotected | only when unprotected and recoverable | only when unprotected and recoverable |
| `SOURCE_OF_TRUTH` | allow | only when unprotected | only when repository-recoverable | only when recoverable |
| `EVIDENCE` | allow | only when durable | only when already recoverable | only when durable |
| `DERIVED` | allow | allow when safe | allow when recoverable | allow when recoverable and dependencies permit |
| `SPECULATIVE` | allow | allow when safe | allow when recoverable | allow when recoverable and dependencies permit |

M3 Phase 1 will authorize `EXTERNALIZE` only for already-recoverable units. It will not introduce arbitrary Context Unit artifact creation or a new storage architecture.

The recoverability predicates distinguish exact-enough durability from rebuildability. `artifact`, `repository`, and `memory` are recoverable and durable; `rebuildable` is recoverable but not durable; `none` is neither. Consequently, rebuildable evidence cannot satisfy the durable gate for `EVICT` or `COMPRESS`.

### Dependencies

`depends_on` is the only hard retention relation in the first Validator. If active unit A depends on B, and A remains available while B would become unavailable, B's destructive action is rejected. This applies transitively through the full `depends_on` closure. Missing dependency targets and cycles fail closed.

`supports` is soft when its target remains recoverable. `contradicts` does not automatically lock retention. `supersedes` makes the superseded unit eligible for later reduction when the replacement remains active and valid.

### Runtime token accounting

Pressure supplies `requiredReductionTokens`; the Planner does not. Before execution, the Validator derives only `potentialReductionUpperBound` from Runtime-owned token cost and action rules. `actualReductionTokens` is always `null`.

`KEEP` and `PROMOTE_PROPOSAL` contribute zero. Valid `COMPRESS` contributes `unit.tokens - targetTokens`; `targetTokens` must be lower than the current unit cost. `EXTERNALIZE` and `EVICT` contribute the unit cost as a gross upper bound and mark replacement cost unknown.

### Validation result

The implemented result contains authorized, rejected, and audit-only decisions, Runtime-calculated upper bounds, and `fallbackRequired`. Status is one of:

```text
AUTHORIZED_DEFINITELY_INSUFFICIENT
AUTHORIZED_POTENTIALLY_SUFFICIENT
REJECTED
```

Meeting the requirement is only potentially sufficient until transformation and execution measure the real result. Initial reason codes include:

```text
STALE_INVENTORY
UNKNOWN_UNIT
DUPLICATE_DECISION
PROTECTED_UNIT
NON_RECOVERABLE
ACTIVE_DEPENDENCY
DEPENDENCY_CYCLE
MISSING_DEPENDENCY
AUTHORITY_VIOLATION
UNSUPPORTED_PROMOTION
INVALID_ACTION
INVALID_COMPRESSION_TARGET
FAILURE_ENVELOPE_RISK
```

M3 also stops before execution:

```text
Planner proposal -> Runtime Validator -> ValidatedPlan -> STOP
```

Invalid plans fail closed and request deterministic fallback. Context mutation, transformation, artifact creation, and promotion remain later integration work.

The exact `ValidatedPlan`, policy tables, dependency availability rules, accounting semantics, and purity guarantees are documented in [Compaction Authorization](../COMPACTION_VALIDATION.md).

## M4: Bounded Semantic Proposal Generation — implemented in 0.2.0-dev.4

Qwen receives a dedicated `PlannerInventoryView`, never the raw Agent transcript. The view has global request, visible-unit, per-unit representation, task, and output bounds. Deterministic selection prioritizes protection, USER authority, active units, dependency roots, and unresolved state; hidden units remain implicit `KEEP`.

The `planner-v1` prompt runs in an isolated tool-free request at fixed low temperature. Raw output passes through the existing strict CompactionPlan parser, an exact Runtime plan-ID challenge, inventory binding, and `visibleUnitIds` binding. Protocol, visibility, and transient client failures may receive one correction attempt. Stale inventory is discarded without retry. Validator rejection stops and requires fallback; M4 has no validator-aware replanning loop.

Planner attempts and results are audit events in the session JSONL channel, not project memory. Metrics cover input/output tokens, latency, visibility, explicit/implicit decisions, parse attempts, authorization results, reason distributions, potential reduction, Proposal Authorization Rate, and Illegal Proposal Rate. Because M4 performs no execution, it does not claim actual reduction or report PILR/WIR/SCU. See [Bounded Semantic Proposal Generation](../BOUNDED_SEMANTIC_PLANNING.md).

## Future hybrid operation and fallback

M4 is an experimental proposal path and does not take over the `55/65/72/80` lifecycle. The future hybrid path will retain v0.1.2 thresholds as intervention and fallback:

```text
Semantic Planner healthy?
  yes -> pressure trigger + semantic proposal + Runtime validation
  no  -> v0.1.2 deterministic policy
```

Semantic intelligence must be allowed to fail while ContextOS continues to work safely.

## M5: Validated Transformation and Execution — D0-D6 implemented

M3 authorization proves policy eligibility, not current recovery-source existence. Dev.5 adds another permission boundary:

```text
ValidatedPlan
  -> Execution Preflight
  -> ExecutablePlan
  -> TransformationCandidate
  -> ValidatedTransformation       (D4)
  -> atomic execution              (D5)
  -> inventory rebuild/accounting  (D6)
  -> ExecutionReport
```

D0-D4 are zero-mutation. A strict preflight admits only current, potentially sufficient, non-fallback ValidatedPlans with complete inventory coverage. Artifact recovery requires existence and integrity, repository recovery requires a contained valid current source/path, memory recovery requires referenced state, and rebuildable recovery requires an available mechanism. Any failure returns `EXECUTION_PRECONDITION_FAILED` and no `ExecutablePlan`.

D3 rechecks inventory identity and concretizes every executable action without changing Runtime state. KEEP/PROMOTE_PROPOSAL become NOOP/AUDIT_ONLY, EVICT becomes descriptive REMOVE, and EXTERNALIZE receives a deterministic recovery marker. Only COMPRESS uses isolated `transformer-v1`; Runtime computes source/candidate digests and token estimates, while D4 retains sole authority to judge semantic preservation or target compliance. One failure rejects the whole candidate.

D4 binds the candidate to the exact `ExecutablePlan` and current inventory, requires exact unit coverage, and recomputes source/candidate hashes and token estimates. Runtime enforces operation-specific invariants and exact canonical EXTERNALIZE markers before any COMPRESS candidate reaches isolated, tool-free `transform-validator-v1`. The semantic model can only assess preservation; it cannot modify content or override a mechanical failure. Any failure rejects the whole transformation, while success yields an immutable, content-free `ValidatedTransformation` with zero mutation and no actual-reduction claim.

`ValidatedPlan != ExecutablePlan`; recoverability classification is not recovery proof; COMPRESS permission does not authorize arbitrary replacement content. The exact contract and frozen M4 manifest are documented in [Validated Transformation and Execution Contract](../EXECUTION_CONTRACT.md).

Recovery proof is point-in-time evidence rather than a lease. D5 must rerun preflight immediately before commit or atomically recheck the bound inventory and sources; an `ExecutablePlan` is single-use and stale bindings abort the whole execution.

D5 is a model-free exact executor. It rebinds Validation/Candidate/ExecutablePlan/current Inventory, hashes the current source and exact candidate bytes again, and reruns destructive-action recovery verification. All operations are built on a complete message clone and checked for tool-call structure. A context-generation/reference guard closes the asynchronous recovery TOCTOU window; only then does Runtime perform one synchronous message-array reference swap and consume the validation ID. Any failure returns `EXECUTION_ABORTED` with no partial executor mutation. D5 also captures canonical pre-commit accounting and the exact tool-envelope digest without claiming actual reduction.

D6 is post-commit observation, not mutation authority. It requires the exact committed generation and pre-commit inventory identity, synchronizes the existing Context Inventory registry from committed messages, and recomputes the complete ContextManager token envelope with identical tools and fixed overhead. Removed units become inactive, replacements retain stable IDs, and the new fingerprint reflects the commit. `actualReductionTokens` is the signed before-minus-after result and remains separate from M3's potential upper bound. Finalization drift/failure never rolls back or relabels D5; it returns `EXECUTION_FINALIZATION_FAILED` with no actual-reduction claim.

## Release-candidate benchmark design

The first comparison contains three variants under the same model, prompts, fixture, oracle, budgets, and invariants:

- A: frozen deterministic v0.1.2;
- B: semantic decisions under the same safety envelope;
- C: pressure trigger, semantic Planner, Runtime Validator, and v0.1.2 fallback.

Protected information is defined by the fixture oracle, not by whether the Agent later happens to mention it.

For required fact `i`, `R_i` indicates that the oracle still requires it, `L_i` indicates that a probe cannot recover it, and `w_i` is its weight:

```text
PILR = sum(w_i * L_i) / sum(w_i * R_i)
CG   = (tokens_before - tokens_after) / tokens_before
WIR  = 1 - sum(w_i * L_i) / sum(w_i)
SCU  = CG * WIR
```

Metrics are reported separately. SCU is a convenience composite, not a replacement for loss and compression measurements.

## Milestones and gates

| Milestone | Deliverable | Gate |
| --- | --- | --- |
| M0 | Frozen benchmark lock | Tag, fingerprints, fixture, oracle |
| M1 | Context Inventory | Stable IDs, schema validation, protection, dependency validation, serialization isolation |
| M2 | Planner protocol | Strict schema and fake-plan fixtures |
| M3 | Runtime Validator | Proposal is never permission; fail-closed tests |
| M4 | Qwen Planner | Bounded inventory, strict output, fallback |
| M5 | Validated Transformation/Execution | D0-D6 atomic execution, rebuild, and signed accounting implemented |
| RC | A/B/C benchmark | Same control envelope; publish raw results |

M0/M1 shipped in `0.2.0-dev.1`, M2 in `0.2.0-dev.2`, M3 in `0.2.0-dev.3`, bounded proposal generation in `0.2.0-dev.4`, and the complete D0-D6 validated execution/finalization chain in `0.2.0-dev.5`. Each remains independently reviewable. D0-D4 are zero-mutation; D5 is the sole deterministic message-context commit boundary; D6 is model-free derived rebuild/accounting.

## Consequences

The design adds internal structure and observability before semantic behavior. This costs implementation time and temporary duplication between messages and Context Units, but gives later Planner work stable identities, explicit authority, measurable loss, and a validator boundary. It also makes semantic planning removable: disabling it restores the frozen deterministic system instead of leaving a partially model-controlled runtime.
