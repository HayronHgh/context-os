# Architecture

[繁體中文](ARCHITECTURE.zh-TW.md) · English

## Design thesis

ContextOS treats prompt context as a materialized working view, not as the database of an agent.

```text
Repository       = Mutable source of truth
Artifact         = Durable tool evidence
State Transfer   = Derived continuation state
Prompt Context   = Disposable working view
```

This separation allows the runtime to compact or reset a conversation without treating that event as task failure.

## Frozen core invariants

| ID | Invariant |
| --- | --- |
| I1 | The repository is the mutable source of truth. |
| I2 | Persistent state survives conversation reset. |
| I3 | State Transfer is derived state, never source of truth. |
| I4 | Deterministic tool-evidence eviction requires a durable recovery path. |
| I5 | Invalid compaction cannot replace valid history. |
| I6 | File and artifact tools cannot escape the selected project root. |
| I7 | Context pressure cannot silently exceed the safety envelope. |
| I8 | Corrupted auxiliary memory cannot hide unrelated valid memory. |

## Durability model

```mermaid
flowchart TD
    T["Tool evidence"] --> D{"Durable artifact?"}
    D -->|"No"| P["Protected from 55% compression and 65% exchange eviction"]
    D -->|"Yes"| A["Full active representation"]
    A --> B["Bounded representation + artifact ID"]
    B --> E["Evicted representation + recovery references"]
    E --> R["read_artifact"]
```

Persistence and rendering are independent. Results at or below `artifactPersistenceChars` may remain context-only. Larger results receive an exact artifact; results above `maxToolOutputChars` also receive a bounded prompt representation. A complete tool exchange is eligible for deterministic eviction only when all its results are recoverable.

## Components

```mermaid
flowchart LR
    HOST["llama.cpp Web UI / Agent Host"] <--> INF["llama.cpp inference"]
    INF <--> MODEL["Qwen3.6"]
    HOST <--> MCP["ContextOS MCP server"]
    MCP --> TR["ToolRunner"]
    MCP --> MS["MemoryStore / evidence"]
    TR --> REPO["Target repository"]
    CLI["Optional standalone CLI"] --> AR["AgentRuntime"]
    AR --> INF
    AR --> TR
    AR --> MS
```

### MCP capability server (`src/mcp-server.js`, `src/mcp-tools.js`, `src/mcp-resources.js`)

- Uses the official MCP TypeScript SDK over stdio.
- Binds one selected project root to one existing ToolRunner, MemoryStore, RepoMapper, and ToolEvidenceManager.
- Advertises only read capabilities by default; mutation/state tools require explicit `trusted-local` mode.
- Exposes bounded repository, memory, working-state, and artifact resources.
- Reserves stdout for MCP frames and sends diagnostics only to stderr.
- Does not call the model, own conversation history, proxy inference, or wire D0-D6 into the host transcript.

### Host and model boundary

llama.cpp owns the Web UI, conversation, reasoning/streaming path, and model invocation. Qwen3.6 proposes tool calls. ContextOS authorizes and executes only its advertised capabilities, then returns Runtime-derived evidence. This is a sibling integration (`llama.cpp <-> Qwen`, `llama.cpp <-> MCP <-> ContextOS`), not an inference chain through ContextOS.

### CLI (`src/index.js`)

- Parses project, config, approval, and one-shot prompt arguments.
- Initializes the persistent store and runtime.
- Checks server health before accepting work.
- Owns user confirmations for mutating tools.
- Exposes slash commands for state, memory, maps, compaction, and reset.

### Agent runtime (`src/agent-runtime.js`)

- Rebuilds the system prompt from durable state.
- Coordinates model calls and tool-call loops.
- Refreshes context after memory or repository-map updates.
- Externalizes oversized tool output.
- Persists messages, tool activity, usage, and compaction reports.
- Maintains cumulative artifact durability metrics.

### Tool evidence manager (`src/tool-evidence.js`)

- Prepares a canonical full tool-result representation.
- Persists medium and large evidence independently of prompt size.
- Renders full or bounded model-visible representations.
- Adds machine-checkable `context_os` recovery metadata to internal messages.

### Model serialization boundary (`src/context-messages.js`)

- Converts internal context units into OpenAI-compatible messages.
- Removes `context_os` and future runtime-only policy metadata.
- Preserves only protocol fields required by the local model server.

### Context Unit and Inventory (`src/context-unit.js`, `src/context-inventory.js`)

The v0.2 development line adds an observational semantic inventory. Context Units have stable session-scoped IDs, explicit authority and recoverability, Runtime-owned protected reasons, typed dependencies, token cost, and lifecycle. The inventory attaches identity only through internal `context_os` metadata, emits bounded summaries by default, and is inspectable with `/inventory`.

M1 does not authorize context actions and does not alter the frozen pressure policy. It is the structured input boundary for the Planner and Validator described in [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.md).

### CompactionPlan protocol and FakePlanner (`src/compaction-plan.js`, `src/planners/`)

M2 gives untrusted Planner output a strict proposal language. Plans bind to a canonical inventory ID and SHA-256 fingerprint, reference only stable Context Unit IDs, and may propose `KEEP`, `COMPRESS`, `EXTERNALIZE`, `EVICT`, or audit-only `PROMOTE_PROPOSAL`. Unknown fields, stale snapshots, duplicate/unknown units, replacement content, and Planner claims over Runtime-owned state fail closed.

Unmentioned units mean `KEEP`. `FakePlanner` provides a model-free asynchronous test double. M2 itself stops after parsing and snapshot binding; its proposal type never grants permission. See the [CompactionPlan protocol](COMPACTION_PLAN_PROTOCOL.md).

### Runtime Validator (`src/compaction-validator.js`)

M3 converts a bound proposal into a distinct `ValidatedPlan`. Frozen Runtime-owned policy evaluates protection, authority, explicit recoverability predicates, and transitive `depends_on` availability in that order. Missing dependency targets and cycles reject the whole plan. `PROMOTE_PROPOSAL` is audit-only.

The Validator calculates only a gross potential-reduction upper bound and keeps `actualReductionTokens` null. It is a pure, model-free authorization boundary and stops before context mutation, transformation, artifact creation, memory writes, Qwen calls, or deterministic policy changes. See [Compaction authorization](COMPACTION_VALIDATION.md).

### Bounded semantic Planner (`src/planners/`, `src/semantic-proposal.js`)

M4 builds a Planner-specific view from an internal inventory snapshot. Per-unit deterministic representations, visible-unit count, task text, model output, and the complete Planner request all have hard bounds. When not every unit fits, protected, USER, active, dependency-root, and unresolved units receive deterministic priority; excluded units remain implicit `KEEP`.

`QwenPlanner` uses a stateless OpenAI-compatible chat call with no tools, the versioned `planner-v1` system prompt, low temperature, strict JSON, and at most one correction attempt. Plan ID, inventory identity, and visible-unit membership are verified before the unchanged M3 Validator runs. Session audit records experimental attempts/results separately from semantic memory. Validator rejection stops and selects fallback; it never triggers autonomous replanning. See [Bounded semantic planning](BOUNDED_SEMANTIC_PLANNING.md).

### Execution preflight (`src/recovery-verifier.js`, `src/execution-preflight.js`)

Dev.5 D0-D2 adds a read-only boundary between `ValidatedPlan` and execution. A strict preflight admits only a current, potentially sufficient, non-fallback Runtime plan with complete inventory coverage. `RecoveryVerifier` then revalidates every applicable artifact, repository, memory, or rebuildable source against current state. Missing references/providers, integrity drift, path escape, stale inventory, rejected decisions, and insufficient plans fail the whole preflight.

Only successful preflight returns a distinct deep-frozen `ExecutablePlan`. It contains decisions and recovery proofs but no replacement content, mutation callback, write authority, or actual-reduction claim. `config/m4-freeze.json` pins the immutable M4 experiment inputs. See [Validated Transformation and Execution Contract](EXECUTION_CONTRACT.md).

### Transformation candidates (`src/transformation-candidate.js`, `src/context-transformer.js`, `src/qwen-transformer.js`)

D3 rechecks exact inventory identity, binds every decision to a Runtime-computed source-content SHA-256, and emits one immutable candidate per executable decision. KEEP and PROMOTE_PROPOSAL remain NOOP/AUDIT_ONLY; EVICT becomes a descriptive REMOVE; EXTERNALIZE gets a canonical Runtime recovery marker. Only COMPRESS invokes the isolated, tool-free `transformer-v1`, whose strict output contains candidate content and no metadata.

Runtime computes candidate SHA-256 and token estimates after model output. Candidate target overshoot is retained for D4, not retried or rejected by D3. Any stale inventory or one candidate-generation failure rejects the whole preparation. No messages, inventory, lifecycle, artifacts, or memory are mutated.

### Post-transform validation (`src/post-transform-validator.js`, `src/validated-transformation.js`, `src/qwen-transform-validator.js`)

D4 binds the candidate back to the exact `ExecutablePlan` and current inventory, requires every unit exactly once, and recomputes source/candidate digests and candidate token estimates from current Runtime data. Deterministic per-operation rules reject malformed NOOP, AUDIT_ONLY, REMOVE, and EXTERNALIZE candidates; canonical recovery markers are compared by exact content rather than digest alone. COMPRESS candidates must be non-empty, actually reduce estimated tokens, and remain within the requested target.

Only mechanically valid COMPRESS candidates reach the isolated, tool-free `transform-validator-v1`. It returns an assessment-only ACCEPT/REJECT verdict over preservation of facts, constraints, decisions, identifiers, errors, unresolved state, and meaning; it cannot rewrite content or override a Runtime failure. Any failure rejects the whole transformation. Success produces a deep-frozen `ValidatedTransformation` with no replacement content, `zeroMutation: true`, and `actualReductionTokens: null`; D5 must bind it back to the original candidate before any commit.

### Atomic execution (`src/atomic-executor.js`, `src/execution-result.js`)

D5 is model-free and treats `ValidatedTransformation` as approval metadata rather than a self-contained capability. `AtomicExecutor` requires the original candidate and executable plan, exact current inventory identity and unit coverage, Runtime-owned messages, a writable context generation, and a `RecoveryVerifier`. It rechecks every source/candidate SHA-256 and reruns current recovery verification for destructive actions before commit.

All NOOP, AUDIT_ONLY, REMOVE, and exact REPLACE operations are first applied to a complete cloned message context. Runtime validates tool-call structure, detects generation/reference drift across asynchronous recovery checks, and then performs one synchronous message-array reference swap. The validation ID is consumed in the same critical section. Any stale binding, missing recovery source, build failure, repeated validation, or commit failure returns immutable `EXECUTION_ABORTED` without partial executor mutation. D5 also preserves a canonical pre-commit token breakdown and exact tool-envelope digest for D6, but makes no actual-reduction claim.

### Post-commit finalization (`src/execution-finalizer.js`, `src/execution-report.js`)

D6 accepts only an immutable committed `ExecutionResult` bound to the current context generation and the still-stale pre-commit inventory registry. It reruns `ContextInventory.synchronize()` on that existing registry, so removed units become inactive while replacements retain stable IDs and receive current content/token cost. The resulting identity must reflect the committed messages.

Before and after values both come from `ContextManager.estimateComponents()` with the exact same tool-schema digest and fixed overhead. Actual reduction is the signed `before.totalTokens - after.totalTokens`; it is never clamped to zero and remains distinct from M3's gross potential upper bound. Success returns an immutable `ExecutionReport`. Drift, rebuild, or accounting failure returns `EXECUTION_FINALIZATION_FAILED`, preserves `actualReductionTokens: null`, and never rolls back or relabels the D5 commit.

### Context manager (`src/context-manager.js`)

- Estimates utilization from messages, tool schemas, tool choice, and fixed safety overhead.
- Compresses stale output, then prunes complete old tool exchanges while keeping protocol structure intact.
- Selects complete user-turn boundaries for compaction.
- Inserts schema-validated, derived Coding State Transfer into rebuilt context.
- Gates 55% compression and 65% exchange eviction on artifact recoverability.
- Reports created artifacts, persisted characters, compression, eviction, and blocked-eviction counts.
- Stops if the resulting prompt remains above the failure threshold.

### State-transfer validator (`src/state-transfer.js`)

- Requires every continuation-state field and its expected type.
- Rejects malformed JSON, missing fields, wrong types, and unexpected fields.
- Supports a single model retry before compaction fails without replacing history.

### Tool runner (`src/tools.js`)

- Implements file reads, globbing, grep, writes, edits, commands, repository maps, memory access, and episodes.
- Checks both lexical and real filesystem paths against the selected project root.
- Rejects file, directory-symlink, and Windows-junction escapes for reads, writes, and edits.
- Requests approval for writes, edits, and commands.
- Rejects a small set of known destructive command patterns.

### Memory store (`src/memory-store.js`)

- Atomic JSON writes for working state.
- Append-only JSONL session events.
- Markdown project memory.
- JSON episodes and repository map.
- Text artifacts plus JSON metadata.
- Bounded artifact reads by ID with SHA-256 integrity verification.
- Latest-N-valid retrieval for episodes and artifact metadata.

### Repository mapper (`src/repo-mapper.js`)

- Scans common source files while excluding generated or large directories.
- Extracts a small symbol list using language-oriented regular expressions.
- Produces a compact repository summary for the system prompt.

### Local model client (`src/llama-client.js`)

- Uses the OpenAI-compatible health, model, and chat completion endpoints.
- Sends JSON Schema function tools.
- Uses request timeouts and structured error handling.
- Currently uses non-streaming responses.

## Turn lifecycle

```mermaid
sequenceDiagram
    participant U as User
    participant A as AgentRuntime
    participant C as ContextManager
    participant M as Local model
    participant T as ToolRunner
    participant S as MemoryStore

    U->>A: Task
    A->>S: Append user event
    A->>C: Prepare context
    C-->>A: Original or compacted messages
    A->>M: Chat + tool schemas
    M-->>A: Tool call
    A->>T: Execute after policy/approval
    T-->>A: Tool result
    A->>S: Persist result or artifact
    A->>M: Tool message
    M-->>A: Final answer or next tool call
    A-->>U: Result
```

## Failure boundaries

- The repository remains authoritative if summaries are wrong.
- Full artifacts remain on disk if prompt previews are truncated.
- Session JSONL remains available for investigation and future replay.
- The runtime fails closed above the 90% context threshold.
- Non-durable tool evidence is kept when deterministic GC or exchange eviction cannot prove recovery.
- Shell execution is outside the memory and path-containment guarantees; it is not sandboxed.

## Phase 1/2 freeze

v0.1.2 freezes the deterministic baseline. The 0.1.x line may still receive critical bug, security, regression, and documentation fixes, but no new memory architecture, compaction policy, repository intelligence, retrieval engine, or agent topology. Adaptive or semantic planning begins in v0.2.0 and must remain subordinate to these runtime invariants.

## Portability

The Node.js runtime uses ESM, the pinned official MCP SDK, and relative paths. Windows management scripts are the tested control plane; CI covers Windows and Ubuntu on Node 20 and 24. The standalone chat client accepts the required OpenAI-style message/tool-call shapes. The MCP server is host-independent stdio, with llama.cpp `b10295` + Qwen3.6 validated end to end at the protocol boundary.
