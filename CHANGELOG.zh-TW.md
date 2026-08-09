# 變更紀錄

繁體中文 · [English](CHANGELOG.md)

所有重要變更都會記錄於此。

## [0.2.0-dev.2] - 2026-08-09

### Strict CompactionPlan protocol

- 每份 plan 綁定 canonical SHA-256 inventory identity，涵蓋 order、content digest、authority、protection、recoverability、dependencies、lifecycle、source、task 與 token cost。
- 新增 strict `CompactionPlan` parser：exact fields、stable unit references、五種 proposal actions、四種 importance 與 bounded reasons。
- 拒絕 stale inventory、unknown unit、duplicate decision、unknown field/action、invalid ID、Planner-owned Runtime metadata、replacement content 與 authoritative savings claim。
- 定義 Planner 未提到的 unit 為 implicit `KEEP`。
- 新增不使用模型的 asynchronous `FakePlanner`；沒有 Qwen integration 或 plan execution。
- `PROMOTE_PROPOSAL` 保持 data-only，沒有 persistent-memory path。
- 新增固定 inventory、valid/invalid plan fixtures 與雙語 protocol 文件。

## [0.2.0-dev.1] - 2026-08-09

### Adaptive context planning 基礎

- 將 resolved v0.1.2 merge commit 凍結為 annotated benchmark control，記錄精確 llama.cpp、GGUF、prompt、config、chat-template 與 host fingerprints。
- 新增英文與繁體中文 RFC-001。
- 新增經驗證的 Context Unit：stable session/sequence identity、authority、recoverability、protected reasons、typed dependencies、token cost 與 lifecycle。
- 新增 bounded observational Context Inventory 與 `/inventory`，不改動 deterministic context policy。
- 所有 Context Unit metadata 都保留在 model serialization boundary 後方。
- 新增第一份 oracle-backed benchmark fixture 與 M0/M1 tests。

## [0.1.2] - 2026-08-09

### Durability 與 core invariant freeze

- Tool evidence persistence 與 prompt rendering 解耦，中型與大型結果都可持久化
- 加入可 machine-check 的 internal recovery metadata 與 model serialization boundary
- 55% stale-output compression 與 65% exchange eviction 必須通過 artifact recoverability gate
- 加入第 12 個 Runtime tool：`read_artifact`，只接受 ID 並提供 bounded retrieval
- Artifact metadata 記錄 characters、bytes、SHA-256、tool、arguments 與建立時間
- Pruning、State Transfer、reset 與 working-state read 都保留 artifact recovery references
- 將 `listEpisodes(N)` 定義為最新 N 個 valid episodes
- 加入 artifact／compression／eviction／blocked-eviction observability counters
- Durability threshold 順序錯誤時拒絕啟動
- Core invariant tests 從 22 個擴充到 35 個
- 凍結 deterministic Phase 1/2 baseline；adaptive semantic planning 留給 v0.2.0

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
