# 技術報告

繁體中文 · [English](TECHNICAL_REPORT.md)

版本：0.1.1

狀態：Experimental Research MVP

## 範圍

ContextOS 實作本機 coding agent 外部 Context Runtime 的前兩個階段：

- OpenAI-compatible 本機模型的 Coordinator loop
- Runtime 管理的檔案、搜尋、命令、狀態與 episode tools
- 持久 working/project memory
- Repository file/symbol intelligence
- Artifact 外部化
- 由 budget 觸發的 context compaction
- 納入 tool schema 的 input accounting 與經 schema 驗證的 state transfer
- Windows lifecycle 與 diagnostics scripts

尚未實作 AST/LSP graph、semantic retrieval、transactional memory database、多 Agent orchestration、自製 Web UI 或強 process sandbox。

## 實作清單

| 模組 | 責任 |
| --- | --- |
| `src/index.js` | CLI、設定、health check、approval、指令 |
| `src/agent-runtime.js` | Model/tool loop、prompt reconstruction、持久化 |
| `src/context-manager.js` | Budget、pruning、structured compaction |
| `src/llama-client.js` | OpenAI-compatible HTTP client |
| `src/memory-store.js` | JSON、JSONL、Markdown、episodes、artifacts |
| `src/repo-mapper.js` | File scan 與近似 symbol extraction |
| `src/tools.js` | 11 個模型工具與 guardrails |
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

使用率的分子包含 messages、完整 tool schemas、`tool_choice` 與固定 prompt 安全餘量。較舊的完整 turns 會轉成通過 schema 驗證的衍生 continuation state；無效 compaction 會重試一次，之後 fail loud 且不取代 history。即使 tool output 的 prompt preview 被縮短，完整內容仍保留在磁碟。

## 安全性質

- File tools 對既存 components 強制 lexical 與 real-path project-root containment。
- Read、write、edit 會拒絕 symbolic-link file、directory link 與 Windows junction escape。
- Scan 不跟隨 symbolic link。
- Mutation tools 預設需要 approval。
- 常見 destructive commands 會被拒絕。
- Server example 只綁 localhost。

這些是 guardrails，不是 sandbox。已核准 shell command 具有 host user 權限。

## 驗證

目前共有 22 個 invariant tests，涵蓋 tool-schema accounting、threshold 行為、tool-call boundary、malformed state transfer 的 retry/fail-loud、lexical 與 symlink/junction containment、memory corruption、artifact retention 與 destructive-command denial。只有 host OS 禁止建立 file symlink 時才會條件式跳過該項；Windows junction escape 仍會測試。

目前驗證過的本機 profile 已以 llama.cpp + Qwen3.6、64K context、8K Agent output、4K reasoning budget 完成 tool-call 端到端 smoke test。教程中的 32K 是故障排除 fallback，不是該次驗證使用的配置。

## 研究假設

專案假設：

> 與依賴 conversation history 或 FIFO token eviction 相比，structured external state 能改善 context reset 後的 coding continuation。

在規劃 benchmark 比較多種壓縮策略的 task completion、lost constraints、repeated investigation、recovery tokens 與 recovery time 前，這仍是待驗證假設。

## 主要限制

- Token estimate 已包含 tools 與固定 overhead，但仍為 tokenizer 近似值。
- Repository symbol 由 regex 產生。
- Episodes 依 recency 選擇。
- Response 尚未 streaming。
- State extraction 部分依賴模型主動性。
- Shared project state 沒有 cross-process lock。
- 只有 Windows 管理環境完成驗證。

## 下一階段

1. Context Recovery Benchmark、接近門檻時的 tokenizer 精確計數與 estimator metrics。
2. Validated end-of-turn state extraction。
3. Session replay 與 interruption recovery。
4. tree-sitter/LSP 與 Git-aware repository intelligence。
5. SQLite FTS5/BM25 retrieval。
6. 選用 semantic retrieval。
7. 更強 command isolation。
8. Streaming 與 context/memory inspection UI。
