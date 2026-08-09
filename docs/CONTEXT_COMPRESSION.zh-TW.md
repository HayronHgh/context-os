# Context 壓縮

繁體中文 · [English](CONTEXT_COMPRESSION.md)

## 目標

壓縮目標不是產生最短摘要，而是讓舊 context 被移除後，Agent 仍有最高機率正確繼續 coding 任務。

重要資訊包含精確路徑、使用者限制、架構決策與理由、修改檔案、測試命令、觀察到的錯誤、被否決方案、目前狀態與下一步。

## Budget

ContextOS 以 UTF-8 byte length 估算 token。這對混合程式碼與中文刻意偏保守，但並非 tokenizer 精確值。

```text
usable input budget = contextWindow - reservedOutputTokens
```

預設 64K profile 保留 12K output，留下約 53K estimated input budget。

## 階段

| 使用率 | 階段 | 行為 |
| ---: | --- | --- |
| 55% | Garbage collection | 縮短過期的大型 tool messages |
| 65% | Pruning | 移除舊結果中可丟棄細節 |
| 72% | Semantic compaction | 產生 Coding State Transfer |
| 80% | Hard transfer | 強制執行 state transfer |
| 90% | Failure | 停止，而非靜默丟失必要狀態 |

## Artifact 外部化

超過 `maxToolOutputChars` 的工具結果會寫入 `.qwen-agent/artifacts/`。Prompt 只收到 artifact path、說明與有上限的 head/tail preview。

這既保留可稽核性，也避免單一 compiler/test log 主導後續 prompt。

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
  "currentState": "",
  "nextActions": []
}
```

結果會以權威 continuation message 插回 context，也會複製到持久 working state。

## 為什麼不用 FIFO context shift？

FIFO eviction 只知道 token 位置，不知道因果重要性。它可能保留最近的檔案 dump，卻刪除解釋實作理由的架構決策。Context shift 可作為緊急 backend optimization，但不是 semantic memory policy。

## 已知弱點

- 同一個模型同時執行任務與 compaction。
- State Transfer 尚未做 JSON Schema validation。
- Token accounting 為估算。
- Compaction 改變 prompt prefix，可能降低 KV reuse。
- 尚無 benchmark 證明預設門檻最佳。

規劃中的 Context Recovery Benchmark 會比較 no compression、FIFO shift、自然語言摘要、structured state transfer，以及 state transfer 加 persistent memory。
