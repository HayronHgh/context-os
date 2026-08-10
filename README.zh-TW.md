# ContextOS

繁體中文 · [English](README.md)

> **讓任務壽命不再受限於 context window 壽命。**

ContextOS 是一個實驗性的本機 coding-agent 持久 context、記憶與 MCP capability Runtime。llama.cpp 仍負責 inference 與 interaction；ContextOS 將容易消失的 state 外部化，並透過標準 local MCP 提供受 policy 控制的 repository、memory 與 evidence capabilities。

[![CI](https://github.com/HayronHgh/context-os/actions/workflows/ci.yml/badge.svg)](https://github.com/HayronHgh/context-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: Experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#目前狀態)

## 為什麼需要它？

許多本機 Agent 隱含地假設：

```text
conversation history = memory
```

長時間 coding 任務會讓這個假設失效。測試 log、重複讀檔、過期工具結果與舊 reasoning 會占滿 context；FIFO context shift 也無法判斷架構決策比 compiler output 更重要。

ContextOS 採用不同模型：

```text
Repository       = 可變動的 source of truth
Artifact         = 持久 tool evidence
State Transfer   = 衍生 continuation state
Prompt Context   = 可拋棄的工作視圖
```

目標很簡單：conversation 可以被壓縮或重設，但任務不能因此死亡。

## 目前狀態

**Experimental · v0.2.0-dev.6 MCP Capability Server · Windows-first**

Deterministic 控制組仍凍結在 [`v0.1.2`](https://github.com/HayronHgh/context-os/tree/v0.1.2)，M4 experiment inputs 仍固定於 `aa59f4d`，D0-D6 dev.5 execution contract 完全不變。dev.6 在既有 tools、evidence、memory、artifacts 與 repository policy 外加上標準 stdio MCP capability boundary。llama.cpp 仍是 inference Runtime 與主要 Web UI／Agent Host；ContextOS 不擁有 transcript，也不代理 model traffic。

已驗證環境：

- llama.cpp `b10295` OpenAI-compatible chat/tool API；原生 MCP Host 相容性依 tagged source 與 exact protocol flow 驗證
- Qwen3.6-35B-A3B GGUF
- Windows 11、Node.js 24、NVIDIA CUDA
- 64K active context、8K Agent output、4K reasoning budget
- v0.1.2 `read_file → artifact → read_artifact` 端到端 recovery path
- 官方 MCP SDK negotiation 與 llama.cpp MCP `2024-11-05` protocol smoke

Standalone AgentRuntime 沒有綁死特定模型名稱，但 backend 必須回傳 OpenAI-style chat messages 與 tool calls。MCP server 是 host-independent stdio；llama.cpp `b10295` 是目前 compatibility target。其他 Host／model 組合尚未納入正式測試矩陣。

## 功能

- 跨 conversation 的持久 working state
- 可人工編輯的 project memory
- 結構化 episodic memory
- Repository file/symbol map
- Tool output artifact 外部化
- 具有 recovery gate 的 tool-output 壓縮與 exchange eviction
- 有範圍限制且驗證 SHA-256 的 artifact retrieval
- 將 tool schema 納入預算的五級 context pressure 策略
- 使用經 schema 驗證的 Coding State Transfer，而不是普通摘要
- OpenAI-compatible tool-calling loop
- 使用 stable ID 的 Context Unit，明確記錄 authority、recoverability、protection、dependencies 與 lifecycle
- 位於 model serialization boundary 後方的 bounded observational Context Inventory
- 可拒絕 stale plan binding 的 canonical inventory SHA-256 identity
- 使用 default KEEP 與 proposal-only actions 的 strict CompactionPlan parser
- 不使用模型的 FakePlanner 與 valid/invalid protocol fixtures
- Runtime-owned protection、authority、recoverability 與 transitive dependency authorization
- 使用 potential upper-bound token accounting、無 side effect 的獨立 ValidatedPlan
- 具有 global input、unit、visibility 與 output limits 的 bounded PlannerInventoryView
- 使用 versioned prompt、無 tools、最多一次 strict repair 的 isolated Qwen Planner
- Visible-only proposal binding、deterministic fallback、session audit 與 PAR／IPR metrics
- 覆蓋 planner-v1、Planner input／budgets、M2、M3 與 Planner metrics 的 M4 freeze manifest
- Read-only artifact、repository、memory 與 rebuildable recovery-source verification
- Strict `ValidatedPlan` admission gate 與 distinct、deep-frozen `ExecutablePlan`
- Runtime-owned source／candidate SHA-256 binding 與 deterministic non-COMPRESS candidates
- 使用一次 schema-only repair、無 tools 的 isolated `transformer-v1` COMPRESS generation
- 不具 execution authority 的 whole-plan immutable `TransformationCandidate`
- Runtime-first post-transform gates：exact binding、digests、token estimates、operation rules 與 compression targets
- 僅供 COMPRESS 使用的 isolated、無 tools `transform-validator-v1` semantic preservation assessment
- Whole-plan immutable `ValidatedTransformation`；任何 mechanical 或 semantic failure 都整份拒絕
- Model-free D5 pre-commit revalidation，重新綁定完整 Validation／Candidate／Plan／Inventory chain
- Single-use、generation-guarded Atomic Executor：whole-plan clone/build 後只做一次 reference-swap commit
- Immutable `ExecutionResult`；stale context、recovery drift 或任何 build failure 都不會留下 partial mutation
- 綁定 exact committed context generation 的 post-commit D6 finalization
- 使用原有 registry rebuild Context Inventory，保留 stable ID，removed unit 轉為 inactive
- Before／after 使用相同 tools／overhead 的 canonical ContextManager accounting，actual reduction 保留正負號
- Immutable `ExecutionReport`；finalization failure 不會把 D5 改報 aborted，也不 rollback commit
- File 與 artifact tools 依 real path 檢查的 project-root 路徑限制
- 寫檔、編輯與 shell command 人工確認
- 破壞性命令 guardrails
- Windows setup、啟停、診斷與可續傳模型下載
- 使用固定版官方 TypeScript SDK 的標準 MCP stdio server
- 預設 read-only tool surface 與顯式 `trusted-local` mutation mode
- Repository map、project memory、working state 與 durable artifacts 的 bounded MCP resources
- 由既有 ToolEvidenceManager 產生的 machine-readable MCP evidence envelope

## 架構

```mermaid
flowchart LR
    U["使用者"] --> H["llama.cpp Web UI / Agent Host"]
    H <--> L["llama.cpp inference"]
    L <--> Q["Qwen3.6"]
    H <--> C["MCP client"]
    C <--> M["ContextOS MCP server"]
    M --> T["ToolRunner / policy"]
    M --> D["Memory / evidence / artifacts"]
    T --> P["目標 Repository"]
```

`.qwen-agent` 目錄名稱為相容初版 MVP 而保留；穩定版前預計改為中性 namespace。

## 快速開始

### 需求

- Windows 10/11
- Node.js 20 以上
- 近期版本的 `llama-server.exe`
- 支援工具呼叫的 GGUF model
- 足以載入模型與 context 的 RAM/VRAM

### 1. Clone

```powershell
git clone https://github.com/HayronHgh/context-os.git
cd context-os
```

### 2. 建立本機設定

雙擊 `00_setup.bat`，或執行：

```powershell
npm run setup
```

它會產生不提交 Git 的：

```text
config/agent.json
config/server.json
config/mcp.json
config/llama-mcp.json
```

編輯 `config/server.json`，填入本機 `llama-server.exe` 與 GGUF 路徑；再以 `config/mcp.json.projectRoot` 選擇 llama.cpp Web UI 可存取的 repository。除非確實要允許本機 mutation，否則保持 `read-only`。

### 3. 診斷與啟動

```text
01_start_server.bat
開啟 http://127.0.0.1:8080
04_health_check.bat
```

`01_start_server.bat` 會把產生的 `config/llama-mcp.json` 傳給 llama.cpp `b10295+`，由 Host 透過 stdio 啟動 ContextOS。`02_start_agent.bat` 仍是選用的 standalone CLI：

```bat
02_start_agent.bat "C:\path\to\your\repository"
```

使用 `03_stop_server.bat` 停止本專案管理的 server。

## Agent 指令

| 指令 | 用途 |
| --- | --- |
| `/health` | 檢查 server 與 model |
| `/map` | 重建 repository map |
| `/state` | 顯示 working state |
| `/memory` | 顯示 project memory |
| `/inventory` | 檢視目前 Context Unit inventory |
| `/compact` | 強制 Coding State Transfer |
| `/new` | 清除 conversation、保留持久狀態 |
| `/project` | 顯示目前 project root |
| `/exit` | 離開 CLI |

## 工具

Read-only MCP mode 公布六個 Runtime-managed tools：

```text
read_file             file_glob_search
grep_search           read_working_state
read_artifact         get_datetime
```

顯式 `trusted-local` mode 才會再公布六個 mutation／state tools：

```text
write_file            edit_file
run_command           build_repo_map
update_working_state  save_episode
```

Standalone CLI 仍使用互動 approval。MCP stdio 沒有互動 approval channel，因此 read-only 直接不公布 mutations；`trusted-local` 則是顯式 non-interactive auto-approval。所有 call 仍通過既有 containment、command policy 與 evidence handling。

## 持久狀態

每個目標 repository 都會建立：

```text
.qwen-agent/
├── state.json
├── project.md
├── repo-map.json
├── episodes/
├── artifacts/
└── sessions/
```

| 狀態 | 用途 | 建議提交？ |
| --- | --- | --- |
| `project.md` | 團隊共享的架構與慣例 | 選擇性 |
| `state.json` | 目前任務狀態 | 否 |
| `repo-map.json` | 自動產生的索引 | 否 |
| `episodes/` | 已解決問題記憶 | 否 |
| `artifacts/` | 完整工具輸出 | 否 |
| `sessions/` | Conversation/tool event log | 否 |

## Context pressure 策略

有效 input budget 為 `contextWindow - reservedOutputTokens`。使用率會計入 messages、完整 tool definitions、`tool_choice`，以及可設定的 chat-template 固定安全餘量。

| 使用率 | 行為 |
| ---: | --- |
| 55% | 壓縮過期且過大的 tool output |
| 65% | 移除完整的過期 tool-call/result exchanges |
| 72% | 將舊 turns 壓縮為結構化 Coding State Transfer |
| 80% | 強制 transfer，只保留最新 user work window |
| 90% | 停止，避免靜默遺失狀態 |

ContextOS 在 55% 不會壓縮沒有 durable artifact 的 tool evidence，在 65% 也不會移除未完整具備 recovery path 的 tool exchange。Non-durable evidence 會留在 context，Runtime 並記錄被阻止的 eviction。Semantic 與 hard State Transfer 保持 v0.1.1 的 deterministic 行為。

超過 `artifactPersistenceChars` 的結果會獨立於 prompt rendering 持久化。大型 prompt representation 受 `maxToolOutputChars` 限制，精確內容可透過 `read_artifact` 取回。

## 安全

> [!WARNING]
> ContextOS 是實驗性 coding-agent Runtime。Shell execution **沒有 sandbox**。

- 不要對不可信任的 repository 使用 `--yes`。
- `run_command` 經同意後會使用目前帳號權限執行。
- Deny list 不可能涵蓋所有破壞性 shell 表達式。
- `.qwen-agent` 可能包含 source code、command output、路徑或 secrets。
- 不可信程式碼請使用 VM、container 或拋棄式帳號。
- 預設 server 只監聽 localhost；若要開放 LAN，必須另行加入 authentication、TLS、firewall 與更完整 threat model。
- MCP 預設 read-only；不可信內容不可啟用 `trusted-local`、llama.cpp `--agent`、內建 tools 或 MCP CORS proxy。

在重要 repository 使用前，請先閱讀 [docs/SECURITY.zh-TW.md](docs/SECURITY.zh-TW.md)。

## 它有什麼不同？

ContextOS 不打算成為完整 IDE，也不是另一個通用 coding assistant。它聚焦一個更窄的研究問題：

> 本機 coding agent 能否在 context reset 後，依靠外部狀態繼續完成長時間任務？

它把 context lifecycle 當成一級系統問題：tool artifacts 外部化、task state 持久化，並在壓縮或重設後重新 materialize working context。

## 現有限制

- Token 計數為估算，不是 tokenizer 精確值
- Regex symbol extraction，不是 AST/LSP intelligence
- Episodes 只取最近項目
- Chat completion 尚未 streaming
- MCP transport 目前只有 stdio；沒有 remote/LAN MCP service 或 authentication
- File-based persistence，沒有 transaction database
- 沒有強 OS sandbox
- 單一 Coordinator，尚無多 Agent 智庫
- Windows-first 管理腳本

## Roadmap

- **v0.1.2：**deterministic durability 與 Phase 1/2 core freeze
- **v0.2.0：**Adaptive Semantic Context Planning 研究，以及 threshold／semantic／hybrid benchmark
- **v0.2.0-dev.6：**不擁有 Host transcript 的標準 MCP capability server
- **v0.3.0：**tree-sitter、LSP、Git 與 repository graph intelligence
- **v0.4.0：**SQLite FTS5/BM25、graph retrieval 與選用 semantic fallback
- **v0.5.0：**乾淨 context 的 Investigator／Architect／Reviewer think tank

v0.1.2 後，0.1.x 只接受 critical bug、security fix、regression 與 documentation correction。新的 memory architecture、context policy、repository intelligence、agents 與 retrieval engine 全部進入 0.2+。

## 文件

| English | 繁體中文 |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | [系統架構](docs/ARCHITECTURE.zh-TW.md) |
| [Context compression](docs/CONTEXT_COMPRESSION.md) | [Context 壓縮](docs/CONTEXT_COMPRESSION.zh-TW.md) |
| [Memory model](docs/MEMORY_MODEL.md) | [記憶模型](docs/MEMORY_MODEL.zh-TW.md) |
| [Security](docs/SECURITY.md) | [安全說明](docs/SECURITY.zh-TW.md) |
| [Tutorial](docs/TUTORIAL.md) | [完整教程](docs/TUTORIAL.zh-TW.md) |
| [Technical report](docs/TECHNICAL_REPORT.md) | [技術報告](docs/TECHNICAL_REPORT.zh-TW.md) |
| [CompactionPlan protocol](docs/COMPACTION_PLAN_PROTOCOL.md) | [CompactionPlan protocol](docs/COMPACTION_PLAN_PROTOCOL.zh-TW.md) |
| [Compaction authorization](docs/COMPACTION_VALIDATION.md) | [Compaction authorization](docs/COMPACTION_VALIDATION.zh-TW.md) |
| [Bounded semantic planning](docs/BOUNDED_SEMANTIC_PLANNING.md) | [Bounded semantic planning](docs/BOUNDED_SEMANTIC_PLANNING.zh-TW.md) |
| [Execution contract](docs/EXECUTION_CONTRACT.md) | [Execution contract](docs/EXECUTION_CONTRACT.zh-TW.md) |
| [MCP capability server](docs/MCP_SERVER.md) | [MCP capability server](docs/MCP_SERVER.zh-TW.md) |
| [RFC-001: Adaptive Context Planning](docs/rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.md) | [RFC-001：自適應 Context Planning](docs/rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.zh-TW.md) |

## 開發

```powershell
npm ci
npm test
node src/index.js --help
node src/mcp-server.js --help
```

## License

[MIT](LICENSE)
