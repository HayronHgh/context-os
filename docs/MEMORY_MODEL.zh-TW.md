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

Episode 描述一個已解決問題：task、symptoms、root cause、solution、files、verification 與 result。`listEpisodes(N)` 由最新往回掃描，直到取得最新 N 個 **valid** episodes，因此新的 corrupted files 不會遮蔽較舊的有效記憶。相關性排名延後到後續版本。

## Repository knowledge

檔案：`.qwen-agent/repo-map.json`

自動產生的 file metadata 與近似 symbols。它是 retrieval aid，不是 source of truth，應重新生成而非 commit。Invalid JSON 會被視為 cache miss 並重建；它與 corrupted `state.json` 不同，不會阻止 recovery。

## Tool artifacts

目錄：`.qwen-agent/artifacts/`

保存超過 `artifactPersistenceChars` 的 exact command、test、grep、file 或其他 tool evidence。Persistence 與 prompt rendering 分離：中型結果維持完整 active representation，大型結果則使用 bounded preview。

每個文字 artifact 都有 JSON metadata，包含 ID、建立時間、tool、arguments、relative file、characters、bytes 與 SHA-256。`read_artifact` 依 ID 最多取回 500 行、驗證 integrity，而且不接受模型提供的 filesystem path。最近 artifact IDs 會加入重建的 system prompt 與 `read_working_state`，conversation reset 後仍可找到 recovery source。

與 episodes 相同，artifact metadata listing 會略過 corrupted entry，直到收集要求數量的 valid records。Exact artifact read 遇到內容遺失或 hash mismatch 時會 fail loud。

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
