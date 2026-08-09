# 變更紀錄

繁體中文 · [English](CHANGELOG.md)

所有重要變更都會記錄於此。

## [0.2.0-dev.6] - 2026-08-10

### Runtime Chat Gateway

- 新增無 Runtime dependency、只綁定 `127.0.0.1:8787` 的 `node:http` Gateway。
- 每個 Browser session 獨佔一個 `AgentRuntime`、message history、Context Inventory registry 與 project-local MemoryStore；只共用 LlamaClient／llama-server。
- 新增有界且可 replay 的 SSE assistant、tool、context、approval 與 turn lifecycle events，不宣稱 token streaming。
- 將 mutation confirmation 橋接為唯一 Browser approval，具 timeout-deny、single-use decision 與 closed-session denial。
- 新增 responsive vanilla HTML／CSS／JS chat UI，提供即時 tool trace、明確 approval、安全文字渲染，Browser 不持有 transcript。
- 拒絕 cross-site request 與不可信 Host；mutation endpoint 強制 JSON，並加入嚴格 Browser CSP。
- 新增 Windows 一鍵啟停 Gateway script 與雙語 Gateway 文件。
- llama.cpp 維持 inference-only；實驗中的 D0-D6 互動 orchestration 不在這個 milestone 內。

## [0.2.0-dev.5] - 2026-08-10

### Zero-mutation execution preparation

- 固定 M4 `aa59f4d` experiment identity，並以測試鎖定 Planner、M2、M3、PAR／IPR 與 telemetry inputs。
- 新增 read-only `RecoveryVerifier` providers，驗證 artifact integrity、repository containment／current hash、memory reference 與 registered rebuild mechanism。
- 新增 strict `ValidatedPlan` admission checks：current inventory identity、完整 decision coverage、sufficient authorization 與 zero fallback。
- 所有 required current-source proof 通過後，才產生 distinct、deep-frozen `ExecutablePlan`。
- 以 `EXECUTION_PRECONDITION_FAILED` fail closed，不允許 partial execution，並提供 machine-readable recovery errors。
- 新增 whole-plan `ExecutablePlan -> TransformationCandidate` preparation，包含第二次 exact inventory binding gate，且不回傳 partial candidate。
- KEEP、PROMOTE_PROPOSAL、EVICT、EXTERNALIZE 全部 deterministic mapping；canonical recovery marker 只由 Runtime recovery reference／proof 建立。
- 只有 COMPRESS 使用 isolated、無 tools、bounded `transformer-v1`，strict output 僅含 `{ content }`，最多一次 schema-only repair。
- Source／candidate SHA-256 digest 與 candidate token estimate 全由 Runtime 計算；超出 target 的 candidate 仍交由 D4 判斷。
- 新增 Runtime-first D4 validation：exact Candidate／ExecutablePlan／Inventory binding、重算 digest／token、deterministic operation invariants、canonical EXTERNALIZE marker，以及 COMPRESS reduction／target gates。
- 新增 isolated、無 tools `transform-validator-v1` semantic preservation assessment 與固定 reason codes；模型無法修改 candidate，也無法 override mechanical failure。
- 成功產生 immutable whole-plan `ValidatedTransformation`；否則以 `TRANSFORMATION_REJECTED` 整份拒絕，不做 partial approval。
- 新增 model-free D5 Atomic Executor，在 commit 前重新綁定 Validation／Candidate／Plan／Inventory、source／candidate digests 與 fresh recovery proofs。
- 所有 operation 先在 cloned message context 完整 build，通過 tool-call structure 與 context generation 後才以一次 reference swap commit；任何 failure 都不改 active context。
- 強制 single-use validation consumption，輸出 immutable `ExecutionResult`／`EXECUTION_ABORTED`，不允許 partial execution。
- D5 commit 前使用 canonical ContextManager estimator 與 exact tool-schema digest 保存 token accounting，但在 commit 前不宣稱 actual reduction。
- 新增 generation-bound D6 post-commit finalization，以原有 Context Inventory registry rebuild，保留 stable ID 與 inactive lifecycle history。
- 使用相同 estimator／tools／overhead 測量 committed context，保留 signed negative reduction，並將 potential upper bound 與 actual reduction 分開回報。
- 輸出 immutable `ExecutionReport` 或 `EXECUTION_FINALIZATION_FAILED`；finalization failure 不 rollback，也不把 committed D5 改報 aborted。
- 新增完整雙語 D0-D6 dev.5 contract；artifacts 與 memory promotion 仍不存在。

## [0.2.0-dev.4] - 2026-08-10

### Bounded semantic proposal generation

- 新增 deterministic、globally bounded PlannerInventoryView，依 protected／USER／active／dependency／unresolved 優先順序選取；hidden unit 維持 implicit KEEP。
- 新增 versioned `planner-v1` prompt，以及 fixed temperature／token budgets、isolated、無 tools 的 `QwenPlanner` request。
- Raw model output 經既有 strict CompactionPlan protocol parsing，並強制 Runtime plan-ID challenge、inventory identity 與 visible-only decisions。
- Protocol／visibility／client failure 最多 correction 一次；stale inventory 立即 discard，Validator rejection 後直接停止。
- 新增停在 `ValidatedPlan` 的 proposal orchestration，沒有 Transformer、Executor、context mutation、artifact creation 或 memory promotion。
- Planner per-attempt 與 cumulative token／latency telemetry 寫入 session audit，分開 protocol、binding、visibility、client、stale failures，並計算 proposal authorization、illegal proposal、violation 與 decision metrics。
- 新增 fake-client failure-mode tests、六 unit synthetic fixture、雙語 planning 文件與 llama.cpp／Qwen smoke tooling。
- 記錄 dev.5 未來 execution 前必須進行 recovery-source revalidation 的 invariant。

## [0.2.0-dev.3] - 2026-08-09

### Runtime plan authorization

- 新增 deterministic、model-free Runtime Validator，將不可信 `CompactionPlan` 轉為獨立 `ValidatedPlan`，並在 execution 前停止。
- 將 protection、authority 與 recoverability policy 資料化，包括 durable exact-enough recovery predicates。
- Authorization 前先驗證 `depends_on` target 與 cycle，再強制 direct／transitive post-action availability。
- `PROMOTE_PROPOSAL` 維持 audit-only，不修改 memory、lifecycle、authority、context 或 artifact。
- 只回報 Runtime 推導的 potential reduction upper bound；execution 前 `actualReductionTokens` 固定為 null。
- 區分 definitely insufficient authorization、potentially sufficient authorization 與 rejected plan，並提供 deterministic fallback。
- 拒絕 invalid compression target，保留 rejected proposal 與 machine-readable reason code。
- 新增 policy、graph、token accounting、M2 regression、no-side-effect tests 與雙語 validation 文件。

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
