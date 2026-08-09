# Bounded Semantic Proposal Generation

[Traditional Chinese](BOUNDED_SEMANTIC_PLANNING.zh-TW.md) · English

Version: `0.2.0-dev.4`

Status: M4 semantic proposal generation implemented; transformation and execution are absent.

## Research boundary

M4 asks one question:

> Can Qwen produce useful, policy-compatible `CompactionPlan` proposals from a bounded Runtime inventory?

It does not test whether executing a proposal improves context. The implemented pipeline is:

```text
Context Inventory
      ↓
Planner Input Builder
      ↓
Bounded Semantic Planner
      ↓
isolated Qwen call (no tools)
      ↓
raw model output
      ↓
strict CompactionPlan parser
      ↓
inventory + visibility binding
      ↓
Runtime Validator
      ↓
ValidatedPlan
      ↓
STOP
```

M4 does not mutate context, create artifacts, write memory, change lifecycle or authority, transform units, claim actual token savings, or modify the frozen ContextManager/Validator policies.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/planners/planner-input.js` | deterministic bounded `PlannerInventoryView` |
| `src/planners/planner-prompt.js` | fixed benchmarkable prompt `planner-v1` |
| `src/planners/qwen-planner.js` | isolated model call, strict parsing, one correction attempt |
| `src/semantic-proposal.js` | binding → Runtime Validator → STOP orchestration |
| `src/planner-observability.js` | session audit adapter and proposal metrics |

`QwenPlanner.plan(input)` returns a `CompactionPlan`, never a `ValidatedPlan`. The Runtime Validator remains the only permission authority.

## Bounded Planner input

The Planner never receives the normal Agent conversation or a raw transcript. `buildPlannerInput()` consumes an internal inventory snapshot and emits only Runtime facts plus bounded representations:

```json
{
  "schemaVersion": 1,
  "plannerPromptVersion": "planner-v1",
  "requestedPlanId": "plan_...",
  "inventory": {
    "id": "inv_...",
    "fingerprint": "sha256:..."
  },
  "pressure": {
    "ratio": 0.74,
    "requiredReductionTokens": 2000
  },
  "task": {
    "objective": "...",
    "phase": "investigation"
  },
  "stats": {
    "totalUnits": 24,
    "totalTokens": 43200,
    "protectedUnits": 7,
    "recoverableUnits": 13
  },
  "visibleUnitIds": ["cu_..."],
  "units": []
}
```

Each visible unit includes its stable ID, position, kind, authority, token cost, recoverability, protection, dependencies, lifecycle, and a deterministic representation. Runtime metadata is authoritative; the model cannot replace or recalculate it.

### Multi-tier representation

- content up to `fullUnitChars` is visible in full;
- larger content uses deterministic head/middle-omission/tail rendering bounded by `maxUnitChars`;
- no model summarizer is called before the Planner;
- the full content is never included merely because the unit is large.

### Global budget

The first defaults are:

```json
{
  "maxInputTokens": 12000,
  "maxOutputTokens": 2048,
  "maxVisibleUnits": 64,
  "fullUnitChars": 600,
  "maxUnitChars": 1000,
  "maxTaskChars": 1000,
  "temperature": 0.1,
  "maxAttempts": 2
}
```

`maxInputTokens` bounds the complete system + user request and reserves space for one correction instruction. Input token estimation intentionally uses the Runtime's conservative UTF-8 approximation. Metadata that cannot fit fails before a model call.

### Deterministic visibility selection

When not every unit fits, ranking is lexicographic and stable:

1. protected units;
2. `USER` authority;
3. active lifecycle;
4. `depends_on` targets and dependency roots;
5. unresolved errors and hypotheses;
6. remaining units by inventory position and stable ID.

This is a safety envelope, not semantic planning. It never treats hidden units as disposable. Units excluded from `visibleUnitIds` cannot receive explicit decisions and therefore become implicit `KEEP` under the M2 protocol.

## Isolated Qwen call

`QwenPlanner` sends a stateless request containing only:

```text
system: fixed planner-v1 prompt
user: bounded PlannerInventoryView JSON
```

The call has:

- `tools: []`;
- thinking disabled through llama.cpp chat-template kwargs;
- fixed low temperature;
- fixed output-token budget;
- JSON object response format;
- no normal coding messages;
- no write, memory, artifact, or Runtime capability.

Only `message.content` is treated as proposal output. Hidden reasoning is not fed into normal conversation and is not required by telemetry.

The frozen `planner-v1` prompt states the complete decision enums and scalar rules: action values, `importance` values (`critical`, `high`, `medium`, `low`), non-empty `reason`, and a positive-integer `targetTokens` present only for `COMPRESS`. The strict parser remains authoritative.

## Strict output and retry

Raw output is untrusted. The adapter may remove one enclosing JSON code fence, but it does not repair JSON or rewrite fields. It then applies:

1. strict M2 `parseCompactionPlan()`;
2. exact `requestedPlanId` challenge;
3. exact inventory identity;
4. `decision.unitId ∈ visibleUnitIds`.

`PLAN_UNIT_NOT_VISIBLE` prevents a model from acting on a real unit that was outside its bounded view.

Retry behavior is fixed:

| Failure | Behavior |
| --- | --- |
| malformed/schema/duplicate decision | one correction attempt |
| wrong plan ID | one correction attempt |
| non-visible unit | one correction attempt |
| transient client error | one correction attempt |
| stale inventory | discard immediately; no retry on stale input |
| two failed attempts | `PLANNER_FAILED` + deterministic fallback |
| Validator rejection | STOP + fallback; no autonomous replanning |

The correction message includes only the machine-readable error code/path, not the invalid raw output.

## Audit and metrics

`createPlannerSessionAudit(memory)` writes Planner events through the existing session JSONL channel. It never calls project-memory or episode APIs.

Attempt events record prompt version, inventory identity, per-request estimated/observed tokens, visible/hidden unit counts, attempt, parse result, latency, error code, failure category, and raw final-output content. Binding/visibility/stale failures report a successful parse; a client failure reports parsing as not attempted. Events do not record hidden reasoning.

Result-level `PlannerInputTokens`, `PlannerOutputTokens`, and `PlannerLatencyMs` are cumulative across every Planner attempt. This keeps one correction attempt visible as its real total experiment cost instead of reporting only the successful request.

Failure telemetry separates `failedAttempts` and the following categories:

| Category | Meaning |
| --- | --- |
| `protocolFailures` | malformed JSON, schema/duplicate violations, or empty output |
| `bindingFailures` | Runtime plan-ID challenge mismatch |
| `visibilityFailures` | decision for a unit outside `visibleUnitIds` |
| `clientFailures` | model transport/client failure |
| `staleFailures` | model proposal bound to stale inventory identity |

`parseFailures` is retained as the narrower count of malformed JSON, schema violations, and duplicate decisions. It does not include binding, visibility, client, or stale failures.

Result metrics include:

```text
PlannerInputTokens
PlannerOutputTokens
PlannerLatencyMs
VisibleUnits / HiddenUnits
ExplicitDecisions / ImplicitKeeps
ParseAttempts / ParseFailures
FailedAttempts
ProtocolFailures / BindingFailures / VisibilityFailures
ClientFailures / StaleFailures
AuthorizedDecisions / RejectedDecisions / AuditOnlyDecisions
RejectionReasonDistribution
PotentialReductionUpperBound / RequiredReductionTokens
```

Proposal Authorization Rate:

```text
authorized explicit decisions / explicit non-audit decisions
```

Illegal Proposal Rate:

```text
rejected explicit decisions / explicit non-audit decisions
```

M4 does not report PILR, WIR, SCU, or actual context gain because nothing is executed.

## Failure and purity guarantees

- Parser/binding/visibility failure never becomes permission.
- A stale snapshot is not repaired against old input.
- Validator rejection does not start an agentic retry loop.
- Hidden units remain implicit `KEEP`.
- Planner telemetry is experimental session evidence, not semantic memory.
- Plans, inventories, messages, memory, episodes, artifacts, authority, and lifecycle remain unchanged.

## M4 smoke test

`npm run test:m4:e2e` sends a six-unit synthetic inventory to the configured llama.cpp + Qwen model. It does not assert an exact semantic choice. It checks parseability, binding, visible-only decisions, structurally valid Runtime authorization, no mutation, and prints:

```text
V020_M4_E2E_OK
```

## Future execution invariant

M3 authorization proves policy eligibility, not current recovery-source existence. Before dev.5 executes anything, it must revalidate the selected recovery path:

```text
ValidatedPlan
      ↓
Recovery Source Revalidation
      ├─ artifact: existence + integrity
      ├─ repository: current path/source validity
      ├─ memory: referenced state exists
      └─ rebuildable: rebuild mechanism available
      ↓
Transform
      ↓
Post-transform validation
      ↓
Execution + inventory rebuild + re-tokenization
```

Any failed revalidation aborts execution and selects deterministic fallback.
