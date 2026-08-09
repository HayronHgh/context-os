# 變更紀錄

繁體中文 · [English](CHANGELOG.md)

所有重要變更都會記錄於此。

## [0.1.1] - 2026-08-09

### Correctness hardening

- Context 使用率納入完整 tool schemas、`tool_choice` 與固定 prompt overhead
- 區分 stale-output 壓縮、完整 tool-exchange pruning、semantic compaction 與 hard transfer
- 驗證 Coding State Transfer 欄位與型別；失敗重試一次，再失敗則保留原 history 並 fail loud
- 將 State Transfer 標示為衍生狀態，可變事實必須以 repository/tool evidence 核對
- File tools 使用 real-path containment，防止 symlink 與 Windows junction 逃逸
- Malformed episode 不會遮蔽有效記憶；corrupted working state 維持 fail loud
- Core invariant tests 從 5 個擴充到 22 個
- 釐清目前 64K 驗證 profile 與 32K 故障排除 fallback

## [0.1.0] - 2026-08-09

### 新增

- 持久 working、project、episodic 與 repository memory
- 11 個 Runtime 管理的 coding tools
- Tool artifact 外部化
- 五段式 context budget 與 Coding State Transfer
- OpenAI-compatible 本機模型 client
- Windows setup、啟停、診斷與下載 scripts
- Project-root file containment 與 mutation approvals
- 初始測試
- English 與繁體中文文件

### 已知限制

- Experimental MVP
- Windows-first
- 沒有強 shell sandbox
- Token 計數為近似，repository map 使用 regex
