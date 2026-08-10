# Technical report

[繁體中文](TECHNICAL_REPORT.zh-TW.md) · English

Version: 0.2.0-dev.6

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
- a standards-compliant stdio MCP server around existing repository, memory, and evidence capabilities
- a default read-only capability surface plus explicit trusted-local mutation mode
- bounded machine-readable MCP resources and evidence envelopes

It does not yet implement AST/LSP graphs, semantic retrieval, a transactional memory database, multi-agent orchestration, a custom Web UI, or a strong process sandbox.

### What dev.6 can do

An MCP Host can launch ContextOS for one selected project, negotiate tools/resources, read and search repository files through the existing ToolRunner, retrieve working/project memory, rebuild maps, and recover exact persisted tool evidence. In explicit `trusted-local` mode it can also write/edit files, update state, save episodes, and—only when separately enabled—run guarded commands. Every executed result uses the existing evidence threshold, artifact integrity metadata, and recovery path.

llama.cpp remains the inference and interaction plane. Qwen3.6 remains the cognitive model. ContextOS neither proxies tokens nor owns the conversation. The frozen Context Policy Engine remains implemented but is not wired into the Host transcript by this milestone.

## Implementation inventory

| Module | Responsibility |
| --- | --- |
| `src/index.js` | CLI, configuration, health check, approvals, commands |
| `src/mcp-server.js` | stdio MCP entrypoint, capability configuration, Runtime composition |
| `src/mcp-tools.js` | Existing-tool schema binding, mode gate, evidence result envelopes |
| `src/mcp-resources.js` | Bounded read-only repository/memory/artifact resources |
| `src/agent-runtime.js` | Model/tool loop, prompt reconstruction, persistence |
| `src/config.js` | Durability defaults and startup invariants |
| `src/context-messages.js` | Internal-to-model serialization boundary |
| `src/context-unit.js` | Context Unit schema, enums, stable ID factory, validation |
| `src/context-inventory.js` | Message inventory, runtime protection, lifecycle, bounded Planner view |
| `src/compaction-plan.js` | Strict proposal schema/parser, snapshot binding, implicit KEEP expansion |
| `src/planners/planner.js` | Model-independent asynchronous Planner contract |
| `src/planners/fake-planner.js` | Fixture-backed Planner test double with cloned I/O and call capture |
| `src/recovery-verifier.js` | Current-source recovery proof providers |
| `src/execution-preflight.js` | Strict ValidatedPlan-to-ExecutablePlan admission gate |
| `src/transformation-candidate.js` | Candidate schema, digests, deterministic action mapping |
| `src/context-transformer.js` | Whole-plan zero-mutation transformation orchestration |
| `src/qwen-transformer.js` | Isolated bounded transformer-v1 COMPRESS generation |
| `src/post-transform-validator.js` | Whole-plan deterministic and semantic candidate validation |
| `src/validated-transformation.js` | Immutable validation success/rejection result schemas |
| `src/qwen-transform-validator.js` | Isolated tool-free transform-validator-v1 assessment |
| `src/atomic-executor.js` | Model-free single-use, generation-guarded atomic context execution |
| `src/execution-result.js` | Immutable committed/aborted execution result schemas |
| `src/execution-finalizer.js` | Generation-bound inventory rebuild and canonical post-commit accounting |
| `src/execution-report.js` | Immutable finalized/finalization-failed report schemas |
| `src/context-manager.js` | Budget, pruning, structured compaction |
| `src/llama-client.js` | OpenAI-compatible HTTP client |
| `src/memory-store.js` | JSON, JSONL, Markdown, episodes, artifacts |
| `src/repo-mapper.js` | File scan and approximate symbol extraction |
| `src/tools.js` | Twelve model-callable tools and guardrails |
| `src/tool-evidence.js` | Tool-result preparation, persistence, rendering, recovery metadata |
| `src/prompts.js` | Runtime and state-transfer prompts |
| `src/state-transfer.js` | Strict state-transfer parsing and schema validation |
| `src/utils.js` | Atomic I/O, path checks, IDs, token estimate |

The core is ESM JavaScript. The MCP boundary pins the official MCP TypeScript SDK and Zod; repository, memory, evidence, planning, and execution logic remains project-owned. PowerShell scripts manage setup, dependency installation, host configuration, server start/stop, diagnostics, and model download.

## Technology

- Node.js 20+ and ECMAScript Modules
- Official `@modelcontextprotocol/sdk` 1.30.0 over stdio and Zod 4.4.3 schema validation
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
- MCP advertises only read tools by default; mutation tools require explicit `trusted-local` mode.
- stdio has no interactive approval channel, so the read-only/trusted-local choice is made before launch and fails closed otherwise.
- Common destructive commands are denied.
- The server example binds to localhost.

These are guardrails, not a sandbox. Approved shell commands have the host user's authority.

## Validation

The suite covers durability ordering, small/medium/large evidence, exact artifact recovery and SHA-256 failure, recovery-gated GC/exchange eviction, runtime metadata serialization, observability counters, latest-N-valid episodes, recoverable repo-map corruption, tool-schema accounting, threshold behavior, state-transfer validation and retry, lexical and symlink/junction containment, fail-loud working-state corruption, and destructive-command denial. A file-symlink test is conditionally skipped only when the host OS denies symlink creation; Windows junction paths remain tested.

The dev.6 MCP suite also runs an official SDK client against the real stdio process, checks exact mode-dependent tool lists and resource contracts, proves that `read_file` still passes through containment/evidence, recovers exact artifacts, rejects malformed/unknown/mutation calls, and sends the same MCP `2024-11-05` initialize flow used by llama.cpp `b10295`.

The v0.1.2 release candidate completed an end-to-end recovery smoke test against llama.cpp + Qwen3.6: the model called `read_file`, received a bounded representation of a 14,116-character persisted artifact, called `read_artifact` by ID, and returned the required success marker. The validated profile used 64K context, 8K agent output, and a 4K reasoning budget. The tutorial's 32K value is a troubleshooting fallback, not the configuration used for that validation.

## Research hypothesis

The project hypothesis is:

> Structured external state improves coding continuation after context reset compared with relying on conversation history or FIFO token eviction.

This remains a hypothesis until the planned benchmark measures task completion, lost constraints, repeated investigation, recovery tokens, and recovery time across multiple compression strategies.

## Primary limitations

- Token estimates include tools and fixed overhead but remain tokenizer-approximate.
- Repository symbols are regex-derived.
- Episodes and artifacts are selected by latest valid recency, not semantic relevance.
- The optional standalone CLI uses non-streaming completions; llama.cpp owns Web UI streaming.
- State extraction is partly model-initiated.
- No cross-process locking exists for shared project state.
- Windows is the only validated management environment.
- MCP transport is local stdio only; no remote authentication or LAN service exists.

## Phase 1/2 freeze and next milestone

v0.1.2 freezes the deterministic Phase 1/2 baseline. Future 0.1.x changes are limited to critical bugs, security, regressions, and documentation corrections.

v0.2.0 is reserved for **Adaptive Semantic Context Planning**: token pressure decides when intervention may be needed, task semantics proposes what matters, and frozen runtime invariants decide which actions are legal. The first benchmark should compare threshold, pure semantic, and hybrid planners without changing the v0.1.2 control group.

`0.2.0-dev.1` completed M0/M1, `0.2.0-dev.2` the strict proposal protocol, `0.2.0-dev.3` deterministic Runtime authorization, and `0.2.0-dev.4` bounded Qwen proposal generation. Dev.5 D0-D6 completed current-source recovery proof, strict preflight, immutable candidate generation/validation, model-free atomic execution, inventory rebuild, and signed post-commit accounting. Dev.6 adds only the MCP capability plane; it does not change those files or semantics. The M4 identity remains hash-pinned, and Host context orchestration remains a separate future integration question. See [MCP Capability Server](MCP_SERVER.md), [Execution Contract](EXECUTION_CONTRACT.md), and [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.md).
