# Context compression

[繁體中文](CONTEXT_COMPRESSION.zh-TW.md) · English

## Objective

The compression objective is not the shortest summary. It is the highest probability that the agent can continue the coding task correctly after older context is removed.

Important details include exact paths, user constraints, architecture decisions and reasons, modified files, test commands, observed failures, rejected approaches, current state, and next actions.

## Budget

ContextOS estimates tokens from UTF-8 byte length. This is intentionally conservative for mixed code and Chinese text, but it is not tokenizer-exact.

```text
usable input budget = contextWindow - reservedOutputTokens
```

The default 64K profile reserves 12K tokens for output, leaving an estimated 53K input budget.

## Stages

| Utilization | Stage | Action |
| ---: | --- | --- |
| 55% | Garbage collection | Shorten stale, oversized tool messages |
| 65% | Pruning | Remove disposable detail from older results |
| 72% | Semantic compaction | Generate Coding State Transfer |
| 80% | Hard transfer | Treat state transfer as mandatory |
| 90% | Failure | Stop rather than silently evict required state |

## Artifact externalization

Tool results above `maxToolOutputChars` are written to `.qwen-agent/artifacts/`. The prompt receives an artifact path, an explanation, and a bounded head/tail preview.

This preserves auditability while preventing a single compiler or test log from dominating future prompts.

## Turn-safe pruning

Tool calling requires assistant tool calls and tool results to remain structurally paired. ContextOS selects user-message boundaries and compacts complete older turns rather than cutting at an arbitrary message index.

## Coding State Transfer

The compactor is instructed to return a JSON object containing:

```json
{
  "objective": "",
  "userRequirements": [],
  "constraints": [],
  "architecture": [],
  "decisions": [],
  "modifiedFiles": [],
  "investigatedFiles": [],
  "tests": [],
  "errors": [],
  "rejectedApproaches": [],
  "currentState": "",
  "nextActions": []
}
```

The result is inserted as an authoritative continuation message and copied into persistent working state.

## Why not FIFO context shift?

FIFO eviction knows token position, not causal importance. It may preserve a recent file dump while deleting the architecture decision that explains the implementation. Context shifting can remain an emergency backend optimization, but it is not a semantic memory policy.

## Known weaknesses

- The same model performs the task and its compaction.
- State Transfer is not yet JSON Schema validated.
- Token accounting is approximate.
- Compaction changes the prompt prefix and may reduce KV reuse.
- There is not yet a benchmark proving the default thresholds are optimal.

The planned Context Recovery Benchmark will compare no compression, FIFO shift, natural-language summary, structured state transfer, and state transfer plus persistent memory.
