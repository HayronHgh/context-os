# 技術報告

繁體中文 · [English](TECHNICAL_REPORT.md)

版本：0.2.0-dev.5

狀態：Experimental Research MVP

## 範圍

ContextOS 實作本機 coding agent 外部 Context Runtime 已凍結的前兩個階段，以及 Phase 3 的 observational／authorization foundation：

- OpenAI-compatible 本機模型的 Coordinator loop
- Runtime 管理的檔案、搜尋、命令、狀態與 episode tools
- 持久 working/project memory
- Repository file/symbol intelligence
- Artifact 外部化
- 由 budget 觸發的 context compaction
- 納入 tool schema 的 input accounting 與經 schema 驗證的 state transfer
- durable tool-evidence envelopes 與具有 recovery gate 的 deterministic eviction
- bounded artifact retrieval、integrity metadata 與 durability observability
- Windows lifecycle 與 diagnostics scripts
- frozen benchmark manifest 與 oracle-backed fixture
- 經驗證的 stable-ID Context Unit 與 bounded observational Context Inventory

尚未實作 AST/LSP graph、semantic retrieval、transactional memory database、多 Agent orchestration、自製 Web UI 或強 process sandbox。

## 實作清單

| 模組 | 責任 |
| --- | --- |
| `src/index.js` | CLI、設定、health check、approval、指令 |
| `src/agent-runtime.js` | Model/tool loop、prompt reconstruction、持久化 |
| `src/config.js` | Durability defaults 與 startup invariants |
| `src/context-messages.js` | Internal-to-model serialization boundary |
| `src/context-unit.js` | Context Unit schema、enums、stable ID factory 與 validation |
| `src/context-inventory.js` | Message inventory、Runtime protection、lifecycle 與 bounded Planner view |
| `src/compaction-plan.js` | Strict proposal schema/parser、snapshot binding 與 implicit KEEP expansion |
| `src/planners/planner.js` | Model-independent asynchronous Planner contract |
| `src/planners/fake-planner.js` | 使用 fixtures、clone I/O 並記錄 calls 的 Planner test double |
| `src/recovery-verifier.js` | Current-source recovery proof providers |
| `src/execution-preflight.js` | Strict ValidatedPlan-to-ExecutablePlan admission gate |
| `src/transformation-candidate.js` | Candidate schema、digests 與 deterministic action mapping |
| `src/context-transformer.js` | Whole-plan zero-mutation transformation orchestration |
| `src/qwen-transformer.js` | Isolated bounded transformer-v1 COMPRESS generation |
| `src/post-transform-validator.js` | Whole-plan deterministic 與 semantic candidate validation |
| `src/validated-transformation.js` | Immutable validation success／rejection result schemas |
| `src/qwen-transform-validator.js` | Isolated、無 tools 的 transform-validator-v1 assessment |
| `src/context-manager.js` | Budget、pruning、structured compaction |
| `src/llama-client.js` | OpenAI-compatible HTTP client |
| `src/memory-store.js` | JSON、JSONL、Markdown、episodes、artifacts |
| `src/repo-mapper.js` | File scan 與近似 symbol extraction |
| `src/tools.js` | 12 個模型工具與 guardrails |
| `src/tool-evidence.js` | Tool-result preparation、persistence、rendering、recovery metadata |
| `src/prompts.js` | Runtime 與 state-transfer prompts |
| `src/state-transfer.js` | 嚴格 state-transfer parsing 與 schema validation |
| `src/utils.js` | Atomic I/O、path checks、IDs、token estimate |

核心 Runtime 約一千行、使用 ESM 且零第三方 dependency。PowerShell scripts 管理 setup、server start/stop、diagnostics 與 model download。

## 技術

- Node.js 20+ 與 ECMAScript Modules
- 內建 `fetch`、`AbortController`、`readline`、`fs`、`path`、`child_process`
- OpenAI-style chat completions 與 JSON Schema function tools
- llama.cpp server 作為已驗證 backend
- GGUF 本機模型；Qwen3.6 為已驗證 model family
- JSON/JSONL/Markdown file persistence
- PowerShell 與 batch 作為 Windows control plane
- Node 內建 test runner

## 資料模型

```text
.qwen-agent/
├── state.json        Working state
├── project.md        人工維護的 project memory
├── repo-map.json     自動產生的 repository knowledge
├── episodes/         Solved-problem memory
├── artifacts/        完整工具輸出
└── sessions/         Append-only JSONL events
```

Runtime 從 current state、project memory、recent episodes 與有上限的 repo-map summary 重建 system prompt。

## Context 演算法

```text
<55%   不處理
55%    壓縮過期的大型 tool output
65%    移除完整的過期 tool exchanges
72%    semantic transfer，保留多個最近 user turns
80%    hard transfer，只保留最新 user work window
90%    fail closed
```

使用率的分子包含 model-serialized messages、完整 tool schemas、`tool_choice` 與固定 prompt 安全餘量。Runtime-only `context_os` metadata 不會進入 model request 或 token estimate。

55% 只能縮短 stale durable tool result；65% 必須所有預期 results 都有 artifact，才能 eviction 完整 exchange。Marker 與 State Transfer 會保留 artifact recovery references。Semantic／hard transfer 保持 v0.1.1 deterministic policy；v0.1.2 不導入 semantic planning。

預設超過 800 characters 的 tool result 會 exact persistence；12,000 characters 以內仍在 active context 保留全文，更大結果使用 bounded prompt text。Metadata 記錄 character/byte counts 與 SHA-256；`read_artifact` 只接受 ID，每次最多 500 行。

## 安全性質

- File tools 對既存 components 強制 lexical 與 real-path project-root containment。
- Read、write、edit 會拒絕 symbolic-link file、directory link 與 Windows junction escape。
- Artifact read 拒絕 path input、directory-junction escape 與 integrity mismatch。
- Scan 不跟隨 symbolic link。
- Mutation tools 預設需要 approval。
- 常見 destructive commands 會被拒絕。
- Server example 只綁 localhost。

這些是 guardrails，不是 sandbox。已核准 shell command 具有 host user 權限。

## 驗證

目前共有 35 個 invariant tests，涵蓋 durability ordering、小／中／大型 evidence、exact artifact recovery 與 SHA-256 failure、具有 recovery gate 的 GC/exchange eviction、runtime metadata serialization、observability counters、latest-N-valid episodes、可恢復的 repo-map corruption、tool-schema accounting、threshold 行為、state-transfer validation/retry、lexical 與 symlink/junction containment、fail-loud working-state corruption 與 destructive-command denial。只有 host OS 禁止建立 file symlink 時才條件式跳過該項；Windows junction paths 仍會測試。

v0.1.2 release candidate 已以 llama.cpp + Qwen3.6 完成端到端 recovery smoke test：模型呼叫 `read_file`，取得 14,116-character exact persisted artifact 的 bounded representation，再依 ID 呼叫 `read_artifact`，最後回傳指定 success marker。驗證 profile 使用 64K context、8K Agent output 與 4K reasoning budget。教程中的 32K 是故障排除 fallback，不是該次驗證配置。

## 研究假設

專案假設：

> 與依賴 conversation history 或 FIFO token eviction 相比，structured external state 能改善 context reset 後的 coding continuation。

在規劃 benchmark 比較多種壓縮策略的 task completion、lost constraints、repeated investigation、recovery tokens 與 recovery time 前，這仍是待驗證假設。

## 主要限制

- Token estimate 已包含 tools 與固定 overhead，但仍為 tokenizer 近似值。
- Repository symbol 由 regex 產生。
- Episodes 與 artifacts 依 latest valid recency 選擇，不含 semantic relevance。
- Response 尚未 streaming。
- State extraction 部分依賴模型主動性。
- Shared project state 沒有 cross-process lock。
- 只有 Windows 管理環境完成驗證。

## Phase 1/2 Freeze 與下一階段

v0.1.2 凍結 deterministic Phase 1/2 baseline。後續 0.1.x 只處理 critical bug、security、regression 與 documentation correction。

v0.2.0 保留給 **Adaptive Semantic Context Planning**：token pressure 決定何時可能需要 intervention，task semantics 提議什麼重要，凍結的 runtime invariants 決定哪些 action 合法。第一個 benchmark 應比較 threshold、pure semantic 與 hybrid planners，不能改動 v0.1.2 control group。

`0.2.0-dev.1` 完成 M0/M1，`0.2.0-dev.2` 完成 strict proposal protocol，`0.2.0-dev.3` 完成 deterministic Runtime authorization，`0.2.0-dev.4` 完成 bounded Qwen proposal generation。Dev.5 D0-D4 現在加入 current-source recovery proof、strict `ValidatedPlan` 到 `ExecutablePlan` preflight、immutable zero-mutation `TransformationCandidate` generation，以及 whole-plan post-transform validation。Runtime 重新計算 bindings、hashes、token estimates、operation invariants 與 canonical markers；只有 mechanically valid 的 COMPRESS candidate 會進 isolated `transform-validator-v1`，進行 assessment-only semantic preservation 判定。M4 experiment identity 持續由 hash 固定；execution、mutation、inventory rebuild 與 actual reduction 仍不存在。實作契約記錄於 [CompactionPlan Protocol](COMPACTION_PLAN_PROTOCOL.zh-TW.md)、[Compaction Authorization](COMPACTION_VALIDATION.zh-TW.md)、[Bounded Semantic Planning](BOUNDED_SEMANTIC_PLANNING.zh-TW.md) 與 [Execution Contract](EXECUTION_CONTRACT.zh-TW.md)；完整 threat boundaries 與 gates 定義於 [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.zh-TW.md)。
