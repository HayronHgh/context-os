# Technical report

[繁體中文](TECHNICAL_REPORT.zh-TW.md) · English

Version: 0.1.1

Status: Experimental research MVP

## Scope

ContextOS implements the first two phases of an external context runtime for local coding agents:

- a coordinator loop over an OpenAI-compatible local model
- runtime-managed file, search, command, state, and episode tools
- persistent working and project memory
- repository file/symbol intelligence
- artifact externalization
- budget-triggered context compaction
- tool-schema-aware input accounting and schema-validated state transfer
- Windows lifecycle and diagnostic scripts

It does not yet implement AST/LSP graphs, semantic retrieval, a transactional memory database, multi-agent orchestration, a custom Web UI, or a strong process sandbox.

## Implementation inventory

| Module | Responsibility |
| --- | --- |
| `src/index.js` | CLI, configuration, health check, approvals, commands |
| `src/agent-runtime.js` | Model/tool loop, prompt reconstruction, persistence |
| `src/context-manager.js` | Budget, pruning, structured compaction |
| `src/llama-client.js` | OpenAI-compatible HTTP client |
| `src/memory-store.js` | JSON, JSONL, Markdown, episodes, artifacts |
| `src/repo-mapper.js` | File scan and approximate symbol extraction |
| `src/tools.js` | Eleven model-callable tools and guardrails |
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

The utilization numerator includes messages, complete tool schemas, `tool_choice`, and a fixed prompt safety margin. Old complete turns are converted into schema-validated derived continuation state. Invalid compaction is retried once and then fails loudly without replacing history. Large tool output remains on disk even after its prompt preview is shortened.

## Security properties

- File tools enforce lexical and real-path project-root containment for existing components.
- Symbolic-link files, directory links, and Windows junction escapes are rejected for reads, writes, and edits.
- Symbolic links are not traversed during scans.
- Mutating tools require approval by default.
- Common destructive commands are denied.
- The server example binds to localhost.

These are guardrails, not a sandbox. Approved shell commands have the host user's authority.

## Validation

The suite now defines 22 invariant tests covering tool-schema accounting, threshold behavior, tool-call boundary preservation, malformed state transfer and retry/fail-loud behavior, lexical and symlink/junction containment, memory corruption behavior, artifact retention, and destructive-command denial. A file-symlink test is conditionally skipped only when the host OS denies symlink creation; the Windows junction escape path remains tested.

The current validated local profile completed an end-to-end tool-call smoke test against llama.cpp + Qwen3.6 with 64K context, 8K agent output, and a 4K reasoning budget. The tutorial's 32K value is a troubleshooting fallback, not the configuration used for that validation.

## Research hypothesis

The project hypothesis is:

> Structured external state improves coding continuation after context reset compared with relying on conversation history or FIFO token eviction.

This remains a hypothesis until the planned benchmark measures task completion, lost constraints, repeated investigation, recovery tokens, and recovery time across multiple compression strategies.

## Primary limitations

- Token estimates include tools and fixed overhead but remain tokenizer-approximate.
- Repository symbols are regex-derived.
- Episodes are selected by recency.
- Responses are non-streaming.
- State extraction is partly model-initiated.
- No cross-process locking exists for shared project state.
- Windows is the only validated management environment.

## Next engineering milestones

1. Context Recovery Benchmark, tokenizer-exact near-threshold accounting, and estimator metrics.
2. Validated end-of-turn state extraction.
3. Session replay and interruption recovery.
4. tree-sitter/LSP and Git-aware repository intelligence.
5. SQLite FTS5/BM25 retrieval.
6. Optional semantic retrieval.
7. Stronger command isolation.
8. Streaming and a context/memory inspection UI.
