# Technical report

[繁體中文](TECHNICAL_REPORT.zh-TW.md) · English

Version: 0.2.0-dev.5

Status: Experimental research MVP

## Scope

ContextOS implements the frozen first two phases of an external context runtime for local coding agents and the observational/authorization foundation of Phase 3:

- a coordinator loop over an OpenAI-compatible local model
- runtime-managed file, search, command, state, and episode tools
- persistent working and project memory
- repository file/symbol intelligence
- artifact externalization
- budget-triggered context compaction
- tool-schema-aware input accounting and schema-validated state transfer
- durable tool-evidence envelopes and recovery-gated deterministic eviction
- bounded artifact retrieval, integrity metadata, and durability observability
- Windows lifecycle and diagnostic scripts
- frozen benchmark manifest and oracle-backed fixture
- validated stable-ID Context Units and a bounded observational Context Inventory

It does not yet implement AST/LSP graphs, semantic retrieval, a transactional memory database, multi-agent orchestration, a custom Web UI, or a strong process sandbox.

## Implementation inventory

| Module | Responsibility |
| --- | --- |
| `src/index.js` | CLI, configuration, health check, approvals, commands |
| `src/agent-runtime.js` | Model/tool loop, prompt reconstruction, persistence |
| `src/config.js` | Durability defaults and startup invariants |
| `src/context-messages.js` | Internal-to-model serialization boundary |
| `src/context-unit.js` | Context Unit schema, enums, stable ID factory, validation |
| `src/context-inventory.js` | Message inventory, runtime protection, lifecycle, bounded Planner view |
| `src/compaction-plan.js` | Strict proposal schema/parser, snapshot binding, implicit KEEP expansion |
| `src/planners/planner.js` | Model-independent asynchronous Planner contract |
| `src/planners/fake-planner.js` | Fixture-backed Planner test double with cloned I/O and call capture |
| `src/context-manager.js` | Budget, pruning, structured compaction |
| `src/llama-client.js` | OpenAI-compatible HTTP client |
| `src/memory-store.js` | JSON, JSONL, Markdown, episodes, artifacts |
| `src/repo-mapper.js` | File scan and approximate symbol extraction |
| `src/tools.js` | Twelve model-callable tools and guardrails |
| `src/tool-evidence.js` | Tool-result preparation, persistence, rendering, recovery metadata |
| `src/prompts.js` | Runtime and state-transfer prompts |
| `src/state-transfer.js` | Strict state-transfer parsing and schema validation |
| `src/utils.js` | Atomic I/O, path checks, IDs, token estimate |

The core runtime is roughly one thousand lines of dependency-free ESM JavaScript. PowerShell scripts manage setup, server start/stop, diagnostics, and model download.

## Technology

- Node.js 20+ and ECMAScript Modules
- Built-in `fetch`, `AbortController`, `readline`, `fs`, `path`, and `child_process`
- OpenAI-style chat completions and JSON Schema function tools
- llama.cpp server as the validated backend
- GGUF local models; Qwen3.6 is the validated model family
- JSON/JSONL/Markdown file persistence
- PowerShell and batch files for the Windows control plane
- Node's built-in test runner

## Data model

```text
.qwen-agent/
├── state.json        Working state
├── project.md        Human-maintained project memory
├── repo-map.json     Generated repository knowledge
├── episodes/         Solved-problem memory
├── artifacts/        Full tool output
└── sessions/         Append-only JSONL events
```

The runtime reconstructs the system prompt from current state, project memory, recent episodes, and a bounded repository-map summary.

## Context algorithm

```text
<55%   no action
55%    compress stale oversized tool output
65%    evict complete stale tool exchanges
72%    semantic transfer with multiple recent user turns
80%    hard transfer with only the latest user work window
90%    fail closed
```

The utilization numerator includes model-serialized messages, complete tool schemas, `tool_choice`, and a fixed prompt safety margin. Runtime-only `context_os` metadata is excluded from model requests and token estimates.

At 55%, only stale durable tool results can be shortened. At 65%, a complete exchange can be evicted only when every expected result has an artifact. Markers and State Transfer preserve artifact recovery references. Semantic and hard transfer retain the v0.1.1 deterministic policy; v0.1.2 does not introduce semantic planning.

Tool results above 800 characters are persisted exactly by default. Results through 12,000 characters stay full in active context; larger results use bounded prompt text. Metadata records character/byte counts and SHA-256, while `read_artifact` provides ID-only retrieval capped at 500 lines.

## Security properties

- File tools enforce lexical and real-path project-root containment for existing components.
- Symbolic-link files, directory links, and Windows junction escapes are rejected for reads, writes, and edits.
- Artifact reads reject path input, directory-junction escape, and integrity mismatch.
- Symbolic links are not traversed during scans.
- Mutating tools require approval by default.
- Common destructive commands are denied.
- The server example binds to localhost.

These are guardrails, not a sandbox. Approved shell commands have the host user's authority.

## Validation

The suite now defines 35 invariant tests covering durability ordering, small/medium/large evidence, exact artifact recovery and SHA-256 failure, recovery-gated GC/exchange eviction, runtime metadata serialization, observability counters, latest-N-valid episodes, recoverable repo-map corruption, tool-schema accounting, threshold behavior, state-transfer validation and retry, lexical and symlink/junction containment, fail-loud working-state corruption, and destructive-command denial. A file-symlink test is conditionally skipped only when the host OS denies symlink creation; Windows junction paths remain tested.

The v0.1.2 release candidate completed an end-to-end recovery smoke test against llama.cpp + Qwen3.6: the model called `read_file`, received a bounded representation of a 14,116-character persisted artifact, called `read_artifact` by ID, and returned the required success marker. The validated profile used 64K context, 8K agent output, and a 4K reasoning budget. The tutorial's 32K value is a troubleshooting fallback, not the configuration used for that validation.

## Research hypothesis

The project hypothesis is:

> Structured external state improves coding continuation after context reset compared with relying on conversation history or FIFO token eviction.

This remains a hypothesis until the planned benchmark measures task completion, lost constraints, repeated investigation, recovery tokens, and recovery time across multiple compression strategies.

## Primary limitations

- Token estimates include tools and fixed overhead but remain tokenizer-approximate.
- Repository symbols are regex-derived.
- Episodes and artifacts are selected by latest valid recency, not semantic relevance.
- Responses are non-streaming.
- State extraction is partly model-initiated.
- No cross-process locking exists for shared project state.
- Windows is the only validated management environment.

## Phase 1/2 freeze and next milestone

v0.1.2 freezes the deterministic Phase 1/2 baseline. Future 0.1.x changes are limited to critical bugs, security, regressions, and documentation corrections.

v0.2.0 is reserved for **Adaptive Semantic Context Planning**: token pressure decides when intervention may be needed, task semantics proposes what matters, and frozen runtime invariants decide which actions are legal. The first benchmark should compare threshold, pure semantic, and hybrid planners without changing the v0.1.2 control group.

`0.2.0-dev.1` completed M0/M1, `0.2.0-dev.2` the strict proposal protocol, `0.2.0-dev.3` deterministic Runtime authorization, and `0.2.0-dev.4` bounded Qwen proposal generation. Dev.5 D0-D2 now adds current-source recovery proof and a strict zero-mutation `ValidatedPlan` to `ExecutablePlan` preflight boundary. The M4 experiment identity is hash-pinned; transformation, candidate validation, execution, mutation, inventory rebuild, and actual reduction remain absent. The contracts are documented in [CompactionPlan Protocol](COMPACTION_PLAN_PROTOCOL.md), [Compaction Authorization](COMPACTION_VALIDATION.md), [Bounded Semantic Planning](BOUNDED_SEMANTIC_PLANNING.md), and [Execution Contract](EXECUTION_CONTRACT.md); the complete threat boundaries and gates are specified in [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.md).
