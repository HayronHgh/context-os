# 技術報告

繁體中文 · [English](TECHNICAL_REPORT.md)

版本：0.2.0-dev.7

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
- 包裝既有 repository、memory、evidence capabilities 的標準 stdio MCP server
- 預設 read-only capability surface 與顯式 trusted-local mutation mode
- Bounded、machine-readable MCP resources 與 evidence envelopes
- 準備 browser model request 副本的 loopback Host Context Bridge
- exact llama.cpp b10295 Web UI overlay 與一鍵 integrated lifecycle

尚未實作 AST/LSP graph、semantic retrieval、transactional memory database、多 Agent orchestration、自製 Web UI 或強 process sandbox。

### dev.7 可以做什麼

MCP Host 可為一個 selected project 啟動 ContextOS、negotiation tools/resources、透過既有 ToolRunner 讀取與搜尋 repository、取得 working/project memory、重建 map，並恢復 exact persisted tool evidence。只有顯式 `trusted-local` 模式才能 write/edit files、更新 state、保存 episodes，且 `run_command` 還必須另行開啟。每個已執行 result 都沿用 evidence threshold、artifact integrity metadata 與 recovery path。

llama.cpp 仍是 inference 與 interaction plane，Qwen3.6 仍是 cognitive model；browser 仍是完整 conversation 的 authority。每次真正的 browser completion 前，獨立 Host Context Bridge 會計算 messages 加 tool schemas 的壓力，超過 policy threshold 時執行 isolated bounded state transfer，再回傳 prepared request representation。它不代理 completion stream，也不修改 browser database。

64K profile 預留 16K output。Semantic preparation 在剩餘 49,152-token input budget 的 72% 啟動。第一次接入時若 transcript 已過大，會拆成 bounded state-transfer calls，再經相同 strict schema 合併，避免 compaction request 成為第二條 context overflow 路徑。不安全或不合法的 preparation 會 fail closed；llama.cpp native context shift 只作最後 safeguard。

## 實作清單

| 模組 | 責任 |
| --- | --- |
| `src/index.js` | CLI、設定、health check、approval、指令 |
| `src/mcp-server.js` | stdio MCP entrypoint、capability 設定與 Runtime composition |
| `src/mcp-tools.js` | 既有 tool schema binding、mode gate 與 evidence result envelope |
| `src/mcp-resources.js` | Bounded read-only repository／memory／artifact resources |
| `src/agent-runtime.js` | Model/tool loop、prompt reconstruction、持久化 |
| `src/state-transfer-compactor.js` | Strict bounded／chunked Coding State Transfer 與 repair |
| `src/host-context-bridge.js` | Request validation、pressure preparation 與 SHA-256 cache identity |
| `src/host-context-bridge-server.js` | Loopback HTTP、CORS allowlist、body limits、health 與 fail-closed errors |
| `ui-overlay/contextos-bridge.service.ts` | 官方 b10295 Web UI request preflight adapter |
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
| `src/atomic-executor.js` | Model-free、single-use、generation-guarded atomic context execution |
| `src/execution-result.js` | Immutable committed／aborted execution result schemas |
| `src/execution-finalizer.js` | Generation-bound inventory rebuild 與 canonical post-commit accounting |
| `src/execution-report.js` | Immutable finalized／finalization-failed report schemas |
| `src/context-manager.js` | Budget、pruning、structured compaction |
| `src/llama-client.js` | OpenAI-compatible HTTP client |
| `src/memory-store.js` | JSON、JSONL、Markdown、episodes、artifacts |
| `src/repo-mapper.js` | File scan 與近似 symbol extraction |
| `src/tools.js` | 12 個模型工具與 guardrails |
| `src/tool-evidence.js` | Tool-result preparation、persistence、rendering、recovery metadata |
| `src/prompts.js` | Runtime 與 state-transfer prompts |
| `src/state-transfer.js` | 嚴格 state-transfer parsing 與 schema validation |
| `src/utils.js` | Atomic I/O、path checks、IDs、token estimate |

核心使用 ESM JavaScript。MCP boundary 固定官方 MCP TypeScript SDK 與 Zod；repository、memory、evidence、planning 與 execution 邏輯仍由專案本身掌控。PowerShell scripts 管理 setup、dependency installation、Host 設定、server start/stop、diagnostics 與 model download。

## 技術

- Node.js 20+ 與 ECMAScript Modules
- 官方 `@modelcontextprotocol/sdk` 1.30.0 stdio transport 與 Zod 4.4.3 schema validation
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
- MCP 預設只公布 read tools；mutation tools 需要顯式 `trusted-local`。
- stdio 沒有 interactive approval channel，因此 read-only／trusted-local 在 launch 前決定，否則 fail closed。
- 常見 destructive commands 會被拒絕。
- Server example 只綁 localhost。

這些是 guardrails，不是 sandbox。已核准 shell command 具有 host user 權限。

## 驗證

測試涵蓋 durability ordering、小／中／大型 evidence、exact artifact recovery 與 SHA-256 failure、具有 recovery gate 的 GC/exchange eviction、runtime metadata serialization、observability counters、latest-N-valid episodes、可恢復的 repo-map corruption、tool-schema accounting、threshold 行為、state-transfer validation/retry、lexical 與 symlink/junction containment、fail-loud working-state corruption 與 destructive-command denial。只有 host OS 禁止建立 file symlink 時才條件式跳過該項；Windows junction paths 仍會測試。

dev.6 MCP suite 也會以官方 SDK client 連接真實 stdio process，檢查精確 mode-dependent tool list 與 resource contracts，證明 `read_file` 仍經 containment/evidence、exact artifact 可恢復、malformed／unknown／mutation calls 會拒絕，並送出 llama.cpp `b10295` 使用的相同 MCP `2024-11-05` initialize flow。

v0.1.2 release candidate 已以 llama.cpp + Qwen3.6 完成端到端 recovery smoke test：模型呼叫 `read_file`，取得 14,116-character exact persisted artifact 的 bounded representation，再依 ID 呼叫 `read_artifact`，最後回傳指定 success marker。驗證 profile 使用 64K context、8K Agent output 與 4K reasoning budget。教程中的 32K 是故障排除 fallback，不是該次驗證配置。

## 研究假設

專案假設：

> 與依賴 conversation history 或 FIFO token eviction 相比，structured external state 能改善 context reset 後的 coding continuation。

在規劃 benchmark 比較多種壓縮策略的 task completion、lost constraints、repeated investigation、recovery tokens 與 recovery time 前，這仍是待驗證假設。

## 主要限制

- Token estimate 已包含 tools 與固定 overhead，但仍為 tokenizer 近似值。
- Repository symbol 由 regex 產生。
- Episodes 與 artifacts 依 latest valid recency 選擇，不含 semantic relevance。
- 選用 standalone CLI 使用 non-streaming completion；Web UI streaming 由 llama.cpp 擁有。
- State extraction 部分依賴模型主動性。
- Shared project state 沒有 cross-process lock。
- 只有 Windows 管理環境完成驗證。
- MCP transport 只有 local stdio；沒有 remote authentication 或 LAN service。

## Phase 1/2 Freeze 與下一階段

v0.1.2 凍結 deterministic Phase 1/2 baseline。後續 0.1.x 只處理 critical bug、security、regression 與 documentation correction。

v0.2.0 保留給 **Adaptive Semantic Context Planning**：token pressure 決定何時可能需要 intervention，task semantics 提議什麼重要，凍結的 runtime invariants 決定哪些 action 合法。第一個 benchmark 應比較 threshold、pure semantic 與 hybrid planners，不能改動 v0.1.2 control group。

`0.2.0-dev.1` 完成 M0/M1，`0.2.0-dev.2` 完成 strict proposal protocol，`0.2.0-dev.3` 完成 deterministic Runtime authorization，`0.2.0-dev.4` 完成 bounded Qwen proposal generation。Dev.5 D0-D6 完成 current-source recovery proof、strict preflight、immutable candidate generation／validation、model-free atomic execution、inventory rebuild 與 signed post-commit accounting。Dev.6 只加入 MCP capability plane，不修改上述 files 或 semantics。M4 identity 持續 hash-pinned，Host context orchestration 仍是獨立的未來 integration 問題。請參閱 [MCP Capability Server](MCP_SERVER.zh-TW.md)、[Execution Contract](EXECUTION_CONTRACT.zh-TW.md) 與 [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.zh-TW.md)。
