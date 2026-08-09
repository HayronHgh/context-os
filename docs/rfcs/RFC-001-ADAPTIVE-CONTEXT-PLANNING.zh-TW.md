# RFC-001：自適應語意 Context Planning

- 狀態：接受，分階段實作
- 目標版本：v0.2.0
- 控制組：`v0.1.2`，commit `ff2944581c7dd6200a170bc0bd94128e58ffd533`
- English: [English](RFC-001-ADAPTIVE-CONTEXT-PLANNING.md)

## 摘要

ContextOS v0.2.0 要研究的是：如何讓本機 coding agent 依照任務語意決定 context 的取捨，同時不削弱 v0.1.2 已凍結的 deterministic safety envelope。

核心規則是：

> **Token pressure 決定 ContextOS 何時需要介入；任務語意決定哪些資訊值得保留或轉換；Runtime invariants 決定提案中的哪些操作真的合法。**

三層必須分開：

```text
Token Pressure     -> 何時可能需要介入
Semantic Planner   -> 目前任務中什麼看起來重要
Runtime Validator  -> 哪些提案可以被執行
```

Planner 只能提出方案。它不能直接刪除 context、改變 authority、移除 protection，或寫入持久記憶。

## 決策

v0.2.0 分成六個 milestone。M0 先鎖定可重現的 v0.1.2 控制組；M1 只加入可觀測的 Context Inventory。Inventory 可以測試後才建立 Planner 與 Validator protocol；fake plan 通過驗證後才接 Qwen。最後必須在相同安全邊界下比較 deterministic、semantic、hybrid，才決定預設策略。

v0.2.0 不得削弱任何 v0.1.2 invariant。

## 為什麼需要 Context Unit

OpenAI message 是傳輸單位，不一定是資訊單位。一個 assistant message 可能同時含 hypothesis、plan 與 tool calls；一份 command result 可能有數千行雜訊與三行關鍵錯誤。只用 message/FIFO 或門檻刪除，無法表達這些差異。

但讓模型自行管理記憶也不安全。模型可能把使用者 constraint 判為低重要性、丟掉仍支撐 unresolved hypothesis 的 evidence，或把 speculation 寫成永久 project memory。因此 semantic judgment 不能等同 permission。

## 非目標

本 RFC 不包含：

- AST、LSP、Git graph 或 repository graph intelligence；
- vector retrieval 或新記憶資料庫；
- multi-agent planning；
- 由模型直接執行 persistent-memory promotion；
- 移除 v0.1.2 的 pressure thresholds；
- 宣稱第一版 Context Unit extractor 已能完整切分所有語意。

## 凍結的安全邊界

Planner 永遠位於 v0.1.2 的 I1-I8 之下：

1. Repository file 是可變動的 source of truth。
2. 必要 task state 必須能跨 conversation reset 存活。
3. State Transfer 是 derived continuation state，不是 authority。
4. Deterministic tool-evidence eviction 必須有 durable recovery path。
5. 無效 compaction output 不得取代有效 history。
6. File/artifact tools 必須留在選定 project root 內。
7. Pressure handling 不得靜默超出設定 envelope。
8. 損壞的 auxiliary memory 不得遮蔽其他有效記憶。

任何 plan 都不能繞過 durability、authority、path containment、fail-loud 與 context safety。

## M0：Frozen benchmark control

控制組是 annotated tag `v0.1.2`，不是原 PR head。Manifest 位於 [benchmarks/baselines/v0.1.2.json](../../benchmarks/baselines/v0.1.2.json)，記錄：

- ContextOS resolved commit 與 source blob fingerprints；
- llama.cpp 精確 build 與 chat-template SHA-256；
- GGUF filename、bytes 與 SHA-256；
- server、context、output、reasoning 與 thresholds；
- host CPU/GPU 與 runtime 版本；
- 第一份 exact fixture/oracle；
- A/B/C variants 與初始 metrics。

比較結果中的控制組不可變。未來 0.1.x 若有 security/correctness fix，必須使用新的 baseline identity，不可暗中改寫本控制組。

## M1：Context Unit

Runtime 新增以下語意記錄：

```ts
interface ContextUnit {
  id: string;
  kind: ContextUnitKind;
  content: string;
  source: { type: string; [key: string]: unknown };
  authority: Authority;
  createdAt: string;
  taskId: string | null;
  recoverability: Recoverability;
  recoveryRef: object | null;
  protectedReasons: ProtectedReason[];
  dependencies: Dependency[];
  tokenCost: number;
  lifecycle: Lifecycle;
}
```

初始 kind 刻意控制在十二種：

```text
USER_REQUIREMENT  USER_CONTEXT
DECISION          HYPOTHESIS
ERROR             TEST_RESULT
TOOL_EVIDENCE     FILE_SNAPSHOT
REASONING         PLAN
STATE_TRANSFER    MEMORY_REFERENCE
```

第一版 extractor 採保守 deterministic 規則，盤點 user、assistant、tool 與 State Transfer message。它允許 Runtime 提供更精確 descriptor，但不呼叫模型分類，也不改變 compaction policy。

### Stable identity

ID 使用 session prefix 與 monotonic sequence：

```text
cu_<session-prefix>_<sequence>
cu_01J8ABC_000127
```

Identity 不等於 position。Context reorder、clone、prune 或 rebuild 都不能改變既有 ID。ID 與 created time 存在內部 `context_os` metadata，經 model serialization boundary 時會被移除。

### Authority 不等於 importance

Authority 表達資訊在系統中的可信或約束位置：

| Authority | 意義 |
| --- | --- |
| `USER` | 使用者提供的 requirement/context |
| `SOURCE_OF_TRUTH` | Repository 當前狀態 |
| `EVIDENCE` | Runtime/tool observation |
| `DERIVED` | State Transfer、summary 或 Runtime conclusion |
| `SPECULATIVE` | Model reasoning 或 hypothesis |

Importance 是 Planner 對「目前任務相關性」的判斷。即使 Planner 認為某個 `USER` requirement importance 很低，也不代表可以刪除；importance 更不能提升 authority。

### Recoverability

第一版值域：

```text
none  artifact  repository  memory  rebuildable
```

Artifact recoverability 必須帶 artifact ID。只有文字 reference、卻沒有已驗證 recovery path，不算 recoverable。Lifecycle 用 `ACTIVE`、`RESOLVED`、`SUPERSEDED`、`EXTERNALIZED`、`EVICTED` 區分狀態，供觀測與後續 Validator 使用。

### Protection 由 Runtime 擁有

初始 protected reason：

```text
EXPLICIT_USER_CONSTRAINT
LATEST_USER_TURN
UNRESOLVED_ERROR
UNRESOLVED_HYPOTHESIS
ACTIVE_DECISION
UNVERIFIED_MODIFICATION
NON_RECOVERABLE_EVIDENCE
DEPENDENCY_ROOT
```

Runtime 依 deterministic state/event 建立與移除 protection。Planner 可以說「它看起來已解決」，但不能清除 protected flag。M1 已保守標記 latest user turn、failed tool evidence 與 non-recoverable evidence。

### Dependencies

M1 只使用小型 typed edge set，不做通用 knowledge graph：

```ts
type Relation = "supports" | "contradicts" | "depends_on" | "supersedes";
```

Reference 必須使用 stable Context Unit ID、不能 self-reference，而且在任何 plan 被授權前必須通過 inventory validation。

## Inventory protocol

Planner 未來接收的是 bounded inventory，而不是一整坨 50K-token transcript：

```json
{
  "pressure": { "ratio": 0.71, "requiredReductionTokens": 9000 },
  "task": { "objective": "...", "phase": "investigation" },
  "stats": { "totalUnits": 12, "totalTokens": 18500 },
  "units": [
    {
      "id": "cu_session_000127",
      "kind": "USER_REQUIREMENT",
      "tokens": 143,
      "authority": "USER",
      "recoverability": "none",
      "protected": true,
      "protectedReasons": ["EXPLICIT_USER_CONSTRAINT"],
      "summary": "Do not change the public API"
    }
  ]
}
```

M1 預設不輸出 full content，只提供 bounded summary；資料仍位於 OpenAI-compatible serialization boundary 後方。`/inventory` 可供人工檢查，目前沒有 Planner 讀取它。

## M2：Planner protocol — 已於 `0.2.0-dev.2` 實作

`CompactionPlan` action：

```text
KEEP
COMPRESS
EXTERNALIZE
EVICT
PROMOTE_PROPOSAL
```

每個 decision 必須包含 stable unit ID、action、task-relative importance 與簡短理由。`COMPRESS` 可以要求正整數 `targetTokens`，但不能提供 replacement content。Planner 提供的 authority、protection、recoverability、lifecycle、promotion content 與 expected savings 都不在 schema 內。

每份 plan 都綁定 canonical inventory ID 與 SHA-256 fingerprint。Fingerprint 涵蓋 position、stable identity、content digest、kind、source、task、authority、lifecycle、protection、recoverability、dependencies 與 token cost。Identity 不符，或 planning 後新增 unit，都會以 stale plan 拒絕整份 proposal。未提到的 unit 預設 `KEEP`。

`FakePlanner` 與固定 valid/invalid fixtures 不使用 Qwen 即可測試 protocol。M2 在 strict parsing、snapshot binding 與 default expansion 後停止，不能 authorize、execute、transform、externalize、evict 或 persist 任何內容。

`PROMOTE_PROPOSAL` 在 v0.2.0 Phase A/B 只供 audit，不寫 project memory。Promotion 比 eviction 更危險：錯誤 speculation 可能污染未來 session，並偽裝成權威事實。精確實作契約請見 [CompactionPlan Protocol](../COMPACTION_PLAN_PROTOCOL.zh-TW.md)。

## M3：Runtime Validator — 已設計，尚未實作

Validator 把 proposal 轉成不同 type 的 permission。它不修改原 Planner plan，也不會把 rejected action 靜默改寫成 `KEEP`。每個結果都保留 proposed action、permission 與 machine-readable reason。

Authorization precedence 固定為：

```text
Runtime protection
  > authority
  > recoverability
  > dependency closure
  > Planner importance/recommendation
```

### Protection

第一版 Validator 中，任何 protected unit 只允許 `KEEP`。`COMPRESS`、`EXTERNALIZE`、`EVICT` 都拒絕。`PROMOTE_PROPOSAL` 最多只授權 audit，active copy 仍然 KEEP。Safety-certified protected compression 不在本階段範圍。

### Authority 與 recoverability

Protection 先於以下 matrix：

| Authority | KEEP | COMPRESS | EXTERNALIZE | EVICT |
| --- | ---: | ---: | ---: | ---: |
| `USER` | 允許 | 僅 unprotected | 僅 unprotected 且 recoverable | 僅 unprotected 且 recoverable |
| `SOURCE_OF_TRUTH` | 允許 | 僅 unprotected | 僅 repository-recoverable | 僅 recoverable |
| `EVIDENCE` | 允許 | 僅 durable | 僅 already-recoverable | 僅 durable |
| `DERIVED` | 允許 | safe 時允許 | recoverable 時允許 | recoverable 且 dependency 允許 |
| `SPECULATIVE` | 允許 | safe 時允許 | recoverable 時允許 | recoverable 且 dependency 允許 |

M3 Phase 1 只允許 already-recoverable unit `EXTERNALIZE`，不加入 arbitrary Context Unit artifact creation 或新 storage architecture。

### Dependencies

第一版 Validator 只把 `depends_on` 視為 hard retention relation。若 active A depends on B，A 仍可用而 B 將變成 unavailable，B 的 destructive action 必須拒絕。規則需套用至完整 transitive `depends_on` closure；missing dependency target 與 cycle 都 fail closed。

`supports` 在 target 可恢復時屬 soft relation；`contradicts` 不自動形成 retention lock；`supersedes` 則在 replacement 仍 active/valid 時，讓被取代 unit 更適合後續 reduction。

### Runtime token accounting

`requiredReductionTokens` 由 pressure 提供，不由 Planner 決定。Validator 依 Runtime-owned `tokenCost` 與 action rules 計算 potential reduction。合法但無法達到 required reduction 的 plan 是 `VALID_BUT_INSUFFICIENT`，不是 schema-invalid，後續需 replan 或 deterministic fallback。

### Validation result

規劃中的 result 包含 authorized/rejected decisions、Runtime-calculated reducible/remaining tokens 與 `fallbackRequired`。初始 reason codes：

```text
STALE_INVENTORY
UNKNOWN_UNIT
DUPLICATE_DECISION
PROTECTED_UNIT
NON_RECOVERABLE
ACTIVE_DEPENDENCY
DEPENDENCY_CYCLE
MISSING_DEPENDENCY
AUTHORITY_VIOLATION
UNSUPPORTED_PROMOTION
INVALID_ACTION
INSUFFICIENT_REDUCTION
FAILURE_ENVELOPE_RISK
```

M3 仍停在 execution 之前：

```text
Planner proposal -> Runtime Validator -> ValidatedPlan -> STOP
```

Invalid plan 必須 fail closed 並要求 deterministic fallback。Context mutation、transformation、artifact creation 與 promotion 都屬於後續 integration。

## M4：Qwen Semantic Planner

Schema 與 Validator 測試通過後，Qwen 才能取得 bounded inventory。Planner endpoint 使用 strict JSON、有限 retry、低 temperature、固定 token budget 與 audit log；Planner output 永遠是不可信輸入。

## Hybrid 與 fallback

v0.1.2 thresholds 繼續負責 intervention 與 fallback：

```text
Semantic Planner healthy?
  yes -> pressure trigger + semantic proposal + Runtime validation
  no  -> v0.1.2 deterministic policy
```

Semantic intelligence 必須允許故障，而 ContextOS 仍能安全工作。

## M5：Benchmark

第一輪只比較三組，且 model、prompt、fixture、oracle、budget 與 invariants 必須一致：

- A：frozen deterministic v0.1.2；
- B：相同安全邊界下的 semantic decisions；
- C：pressure trigger + semantic Planner + Runtime Validator + v0.1.2 fallback。

Required information 由 fixture oracle 預先定義，不能看 Agent 後來有沒有主動提到。

對 required fact `i`，`R_i` 表示 oracle 在 checkpoint 仍要求它；`L_i` 表示 probe 無法恢復；`w_i` 是權重：

```text
PILR = sum(w_i * L_i) / sum(w_i * R_i)
CG   = (tokens_before - tokens_after) / tokens_before
WIR  = 1 - sum(w_i * L_i) / sum(w_i)
SCU  = CG * WIR
```

各 metric 分開報告；SCU 只是方便比較的 composite，不能取代 loss 與 compression 原始數據。

## Milestone gates

| Milestone | 產出 | Gate |
| --- | --- | --- |
| M0 | Frozen benchmark lock | Tag、fingerprints、fixture、oracle |
| M1 | Context Inventory | Stable ID、schema validation、protection、dependency validation、serialization isolation |
| M2 | Planner protocol | Strict schema 與 fake-plan fixtures |
| M3 | Runtime Validator | Proposal 不等於 permission；fail-closed tests |
| M4 | Qwen Planner | Bounded inventory、strict output、fallback |
| M5 | A/B/C benchmark | 相同 control envelope；公開 raw results |

M0/M1 於 `0.2.0-dev.1` 完成；M2 以獨立 `0.2.0-dev.2` 完成；M3 將使用另一個 `0.2.0-dev.3` 實作，使 protocol correctness 與 authorization correctness 可以分開 review。dev.1 與 dev.2 都不修改 deterministic context reduction。

## 影響

這個設計先增加內部結構與 observability，之後才加入 semantic behavior。代價是更多實作工作，以及 message/Context Unit 暫時並存；好處是 Planner 會有 stable identity、明確 authority、可量測 loss 與 Validator boundary。Semantic planning 也能被完整關閉：停用後會回到 frozen deterministic system，而不是留下半套模型控制的 Runtime。
