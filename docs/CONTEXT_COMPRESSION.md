# Context compression

[繁體中文](CONTEXT_COMPRESSION.zh-TW.md) · English

## Objective

The compression objective is not the shortest summary. It is the highest probability that the agent can continue the coding task correctly after older context is removed.

Important details include exact paths, user constraints, architecture decisions and reasons, modified files, test commands, observed failures, rejected approaches, current state, and next actions.

## Budget

ContextOS estimates tokens from UTF-8 byte length. This is intentionally conservative for mixed code and Chinese text, but it is not tokenizer-exact. The estimate covers the serialized messages, complete function-tool definitions, `tool_choice`, and a fixed chat-template safety margin.

```text
usable input budget = contextWindow - reservedOutputTokens
estimated input = messages + tool schemas + tool_choice + fixed prompt overhead
```

The default 64K profile reserves 12K tokens for output, leaving an estimated 53K input budget.

## Context pressure levels

| Utilization | Stage | Action |
| ---: | --- | --- |
| 55% | Garbage collection | Shorten stale, oversized **durable** tool messages |
| 65% | Pruning | Replace fully recoverable stale assistant-tool/result exchanges with a recovery marker |
| 72% | Semantic compaction | Generate Coding State Transfer while retaining multiple recent user turns |
| 80% | Hard transfer | Generate transfer and retain only the latest user work window |
| 90% | Failure | Stop rather than silently evict required state |

## Artifact externalization

Artifact persistence and prompt rendering use separate thresholds:

```text
chars <= artifactPersistenceChars
  context-only; protected from deterministic tool-evidence eviction

artifactPersistenceChars < chars <= maxToolOutputChars
  exact artifact + full active prompt representation

chars > maxToolOutputChars
  exact artifact + bounded prompt representation
```

The startup invariant `artifactPersistenceChars <= staleToolCompressionChars` ensures no output becomes eligible for 55% destructive compression before it has a recovery artifact. Artifact metadata records ID, creation time, tool, arguments, file, character count, byte count, and SHA-256.

This preserves auditability while preventing a single compiler or test log from dominating future prompts.

## Durability gates

Internal tool messages carry `context_os` metadata. At 55%, a stale result can be shortened only when the metadata proves an artifact recovery path. At 65%, an assistant tool-call/result group can be removed only when every expected result is present and durable. Recovery markers retain tool names and artifact IDs.

`context_os` is runtime-only metadata. `serializeMessageForModel()` removes it before normal requests reach llama.cpp. When durable history enters State Transfer, explicit recovery references are materialized into the compaction transcript and its `artifacts` field.

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
  "artifacts": [],
  "currentState": "",
  "nextActions": []
}
```

The runtime validates every required field and type. Invalid output is retried once; if the second result is also invalid, compaction fails without replacing the existing conversation. A valid result is inserted as **derived continuation state** and copied into persistent working state. Mutable facts must still be checked against repository and tool evidence.

`/compact` keeps its v0.1.1 meaning: `force=true` requests hard transfer. v0.1.2 does not add semantic policy decisions to this path.

## Observability

Context reports include cumulative `artifactsCreated` and `artifactCharsPersisted`, plus per-preparation `toolOutputsCompressed`, `toolExchangesEvicted`, and `nonDurableEvictionsBlocked` counters. These are groundwork for the v0.2.0 threshold/semantic/hybrid benchmark, not an adaptive planner.

## Why not FIFO context shift?

FIFO eviction knows token position, not causal importance. It may preserve a recent file dump while deleting the architecture decision that explains the implementation. Context shifting can remain an emergency backend optimization, but it is not a semantic memory policy.

## Known weaknesses

- The same model performs the task and its compaction.
- Token accounting includes tool schemas and safety overhead, but remains tokenizer-approximate.
- Filesystem and model-server tokenizers may still disagree near the limit; tokenizer-exact fallback is planned.
- Compaction changes the prompt prefix and may reduce KV reuse.
- There is not yet a benchmark proving the default thresholds are optimal.

The planned Context Recovery Benchmark will compare no compression, FIFO shift, natural-language summary, structured state transfer, and state transfer plus persistent memory.
