# CompactionPlan Protocol

[Traditional Chinese](COMPACTION_PLAN_PROTOCOL.zh-TW.md) · English

Version: `0.2.0-dev.4`

Status: M2 protocol, M3 Runtime authorization, and M4 bounded proposal generation implemented; transformation and execution are absent.

## Purpose

`CompactionPlan` defines the complete language an untrusted future semantic Planner may use when proposing context changes. It deliberately separates selection from transformation and permission:

```text
M1 Context Inventory
        ↓
M2 CompactionPlan proposal
        ↓
M3 Runtime Validator permission
        ↓
M4 bounded Qwen proposal generation
        ↓
M5 transformation / execution (not implemented)
```

Parsing a valid plan has no effect on active context, artifacts, working state, or project memory.

## Inventory identity

Every inventory snapshot contains:

```json
{
  "inventory": {
    "id": "inv_session_0123456789abcdef",
    "fingerprint": "sha256:..."
  }
}
```

The canonical fingerprint covers each selected unit's:

- position and stable ID;
- kind and source;
- authority and task ID;
- lifecycle;
- recoverability and recovery reference;
- sorted protected reasons;
- sorted typed dependencies;
- token cost;
- SHA-256 content digest.

Changing content, order, protection, authority, recoverability, dependencies, lifecycle, source, task, or token cost changes the fingerprint. Repeated snapshots of unchanged state have the same identity.

This prevents stale-plan and time-of-check/time-of-use errors. `validatePlanBinding()` rejects the whole plan with `STALE_INVENTORY` when either identity field differs from the current inventory.

## Schema

```ts
interface CompactionPlan {
  schemaVersion: 1;
  planId: string;
  inventory: {
    id: string;
    fingerprint: `sha256:${string}`;
  };
  decisions: CompactionDecision[];
}

interface CompactionDecision {
  unitId: string;
  action:
    | "KEEP"
    | "COMPRESS"
    | "EXTERNALIZE"
    | "EVICT"
    | "PROMOTE_PROPOSAL";
  importance: "critical" | "high" | "medium" | "low";
  reason: string;
  targetTokens?: number;
}
```

`targetTokens` is a positive integer and is accepted only for `COMPRESS`. It is a requested representation size, not an authoritative savings claim.

## Strict parser

`parseCompactionPlan()` rejects:

- malformed JSON or non-object plans;
- missing or unknown fields at every schema level;
- unsupported schema versions;
- malformed plan, inventory, fingerprint, or Context Unit IDs;
- unknown actions or importance values;
- empty or oversized reasons;
- duplicate decisions for one unit;
- non-positive or misplaced `targetTokens`;
- replacement content;
- Planner-provided authority, protection, recoverability, lifecycle, promotion content, or token-savings claims.

The parser returns a normalized copy. It never mutates the input.

## Snapshot binding

`validatePlanBinding(plan, inventory)` performs protocol validation, not authorization. It checks:

1. strict plan schema;
2. exact inventory ID and fingerprint;
3. every decision references a unit in that snapshot.

Machine-readable protocol error codes currently include:

```text
MALFORMED_JSON
SCHEMA_VIOLATION
DUPLICATE_DECISION
INVALID_INVENTORY
STALE_INVENTORY
UNKNOWN_UNIT
```

Protection, authority, recoverability, dependency closure, and required token reduction are M3 authorization concerns and remain outside this parser. They are implemented by the separate [Runtime Validator](COMPACTION_VALIDATION.md).

## Default KEEP

A plan is an exception proposal, not ownership of the full context:

> **An unmentioned Context Unit always means KEEP.**

`expandPlanDefaults()` materializes this rule for inspection. Implicit decisions use `UNMENTIONED_DEFAULT_KEEP`; they are not Planner claims.

An empty decision list is valid and keeps every unit.

## Selection is not transformation

`COMPRESS` never carries replacement text. A future Transformer will decide how an authorized compression is represented. This separation allows benchmarks to distinguish a bad selection from a bad summary.

The Planner also cannot provide `expectedTokensSaved`. M3 computes only a potential reduction upper bound from Runtime-owned token costs and action rules; actual reduction remains unknown until later transformation and execution.

## Promotion is proposal-only

`PROMOTE_PROPOSAL` contains only a unit ID, task-relative importance, and reason. It has no target, content, authority, or persistence method. The M3 Validator marks it `AUDIT_ONLY`; v0.2 Phase A/B does not write it to project memory.

## FakePlanner

`FakePlanner` implements the asynchronous Planner interface without a model:

```js
const planner = new FakePlanner({ plan: fixturePlan });
const untrustedOutput = await planner.plan(inventoryInput);
const boundPlan = validatePlanBinding(untrustedOutput, inventorySnapshot);
```

It deep-clones inputs and outputs and records calls for assertions. It intentionally does not parse, validate, authorize, execute, persist, or contact Qwen.

## Test fixtures

The repository includes a fixed four-unit inventory and plan fixtures for:

- valid KEEP, COMPRESS, EXTERNALIZE, and PROMOTE_PROPOSAL;
- unknown unit;
- duplicate decision;
- invalid action;
- stale inventory;
- extra Runtime-owned field;
- negative compression target.

Fixture inventory identity is hard-coded. Any accidental canonicalization change fails the tests rather than silently changing the protocol.

## M2 boundary

At the end of M2:

```text
Inventory → FakePlanner → strict parser → binding check → expanded proposal → STOP
```

M2 itself introduced no `compaction-validator.js`, Qwen Planner, plan retry loop, token-reduction permission, context mutation, artifact creation, or memory promotion. Later milestones remain separate layers over this frozen protocol.

See [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.md) for the authority matrix, dependency closure, fail-closed reasons, and M4/M5 research path. The semantic adapter is documented separately in [Bounded Semantic Planning](BOUNDED_SEMANTIC_PLANNING.md).
