# Context 壓縮

繁體中文 · [English](CONTEXT_COMPRESSION.md)

## 目標

壓縮目標不是產生最短摘要，而是讓舊 context 被移除後，Agent 仍有最高機率正確繼續 coding 任務。

重要資訊包含精確路徑、使用者限制、架構決策與理由、修改檔案、測試命令、觀察到的錯誤、被否決方案、目前狀態與下一步。

## Budget

ContextOS 以 UTF-8 byte length 估算 token。這對混合程式碼與中文刻意偏保守，但並非 tokenizer 精確值。估算範圍包含 serialized messages、完整 function-tool definitions、`tool_choice` 與固定 chat-template 安全餘量。

```text
usable input budget = contextWindow - reservedOutputTokens
estimated input = messages + tool schemas + tool_choice + fixed prompt overhead
```

預設 64K profile 保留 12K output，留下約 53K estimated input budget。

## Context pressure levels

| 使用率 | 階段 | 行為 |
| ---: | --- | --- |
| 55% | Garbage collection | 縮短過期的大型 **durable** tool messages |
| 65% | Pruning | 將完全可恢復的舊 assistant-tool/result exchange 換成 recovery marker |
| 72% | Semantic compaction | 產生 Coding State Transfer，保留多個最近 user turns |
| 80% | Hard transfer | 產生 transfer，只保留最新 user work window |
| 90% | Failure | 停止，而非靜默丟失必要狀態 |

## Artifact 外部化

Artifact persistence 與 prompt rendering 使用不同門檻：

```text
chars <= artifactPersistenceChars
  context-only；禁止 deterministic tool-evidence eviction

artifactPersistenceChars < chars <= maxToolOutputChars
  exact artifact + 完整 active prompt representation

chars > maxToolOutputChars
  exact artifact + bounded prompt representation
```

啟動 invariant `artifactPersistenceChars <= staleToolCompressionChars` 保證 output 不會在建立 recovery artifact 前就符合 55% destructive compression 資格。Artifact metadata 包含 ID、建立時間、tool、arguments、file、character count、byte count 與 SHA-256。

這既保留可稽核性，也避免單一 compiler/test log 主導後續 prompt。

## Durability gates

Internal tool message 帶有 `context_os` metadata。55% 只有 metadata 能證明 artifact recovery path 時才可縮短結果；65% 則必須所有預期 results 都存在且 durable，才能移除整組 assistant tool-call/result。Recovery marker 會保留 tool name 與 artifact ID。

`context_os` 只供 Runtime 使用；正常 request 到 llama.cpp 前，`serializeMessageForModel()` 會移除它。Durable history 進入 State Transfer 時，recovery references 會明確 materialize 到 compaction transcript 與 `artifacts` 欄位。

## Turn-safe pruning

Tool calling 要求 assistant tool calls 與 tool results 維持結構配對。ContextOS 使用 user-message 邊界，壓縮完整的舊 turns，而不是在任意 message index 切斷。

## Coding State Transfer

Compactor 被要求回傳包含以下欄位的 JSON：

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

Runtime 會驗證所有必要欄位與型別。無效輸出會重試一次；第二次仍無效時，compaction 會失敗且不取代原 conversation。有效結果會以**衍生 continuation state**插回 context，也會複製到持久 working state；可變事實仍必須以 repository 與 tool evidence 核對。

`/compact` 保持 v0.1.1 語義：`force=true` 要求 hard transfer。v0.1.2 不在這條路徑加入 semantic policy decision。

## Observability

Context report 包含累計 `artifactsCreated`、`artifactCharsPersisted`，以及每次 preparation 的 `toolOutputsCompressed`、`toolExchangesEvicted`、`nonDurableEvictionsBlocked`。這些是 v0.2.0 threshold／semantic／hybrid benchmark 的 groundwork，不是 adaptive planner。

## 為什麼不用 FIFO context shift？

FIFO eviction 只知道 token 位置，不知道因果重要性。它可能保留最近的檔案 dump，卻刪除解釋實作理由的架構決策。Context shift 可作為緊急 backend optimization，但不是 semantic memory policy。

## 已知弱點

- 同一個模型同時執行任務與 compaction。
- Token accounting 已包含 tool schemas 與安全餘量，但仍為 tokenizer 近似值。
- 接近上限時仍可能與 model-server tokenizer 不同；後續規劃加入 tokenizer-exact fallback。
- Compaction 改變 prompt prefix，可能降低 KV reuse。
- 尚無 benchmark 證明預設門檻最佳。

規劃中的 Context Recovery Benchmark 會比較 no compression、FIFO shift、自然語言摘要、structured state transfer，以及 state transfer 加 persistent memory。
