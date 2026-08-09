# 記憶模型

繁體中文 · [English](MEMORY_MODEL.md)

ContextOS 依生命週期與權威性分離記憶，而不是把整段 conversation 當成唯一 transcript。

## Working memory

檔案：`.qwen-agent/state.json`

欄位包含 objective、current task、constraints、active files、known failures、decisions、next actions、notes 與最新 state transfer。

Working state 先寫 temporary file 再 rename，降低中斷時留下半份 JSON 的機率。

## Project memory

檔案：`.qwen-agent/project.md`

由人可直接編輯的持久專案知識：

- 架構與 subsystem ownership
- Entry points 與 data flow
- Coding conventions
- Build、test、lint commands
- 相容性限制
- 已接受的設計決策

這是唯一可能適合 commit 並與團隊共享的 memory file。是否提交由使用者決定，且可能暴露內部資訊。

## Episodic memory

目錄：`.qwen-agent/episodes/`

Episode 描述一個已解決問題：task、symptoms、root cause、solution、files、verification 與 result。目前 MVP 只取最近 episodes；相關性排名仍在 roadmap。

## Repository knowledge

檔案：`.qwen-agent/repo-map.json`

自動產生的 file metadata 與近似 symbols。它是 retrieval aid，不是 source of truth，應重新生成而非 commit。

## Tool artifacts

目錄：`.qwen-agent/artifacts/`

保存太大、不適合放進 prompt 的完整 command、test、grep 或 file output。每個文字 artifact 都有 JSON metadata。

## Session events

目錄：`.qwen-agent/sessions/`

Append-only JSONL，包含 conversation events、tool calls、results、API usage 與 compaction reports。Session log 用於 debug 與未來 replay，不會完整注入 prompt。

## Git 策略

| Path | 預設策略 |
| --- | --- |
| `project.md` | 選擇性；提交前人工檢查 |
| `state.json` | Ignore |
| `repo-map.json` | Ignore |
| `episodes/` | Ignore |
| `artifacts/` | Ignore |
| `sessions/` | Ignore |

所有 memory files 都應視為可能敏感，其中可能包含程式碼、檔名、內部架構、command output，或工具意外印出的 credentials。
