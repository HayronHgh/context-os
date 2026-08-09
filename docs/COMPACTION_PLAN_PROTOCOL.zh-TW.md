# CompactionPlan Protocol

繁體中文 · [English](COMPACTION_PLAN_PROTOCOL.md)

版本：`0.2.0-dev.3`

狀態：M2 protocol 與 M3 Runtime authorization 已實作；尚無 transformation 與 execution。

## 目的

`CompactionPlan` 定義未來不可信 semantic Planner 能提出的完整語言，刻意分離 selection、transformation 與 permission：

```text
M1 Context Inventory
        ↓
M2 CompactionPlan proposal
        ↓
M3 Runtime Validator permission
        ↓
M4 Qwen proposal generation（未實作）
        ↓
M5 transformation / execution（未實作）
```

解析一份有效 plan 不會改動 active context、artifact、working state 或 project memory。

## Inventory identity

每份 inventory snapshot 都包含：

```json
{
  "inventory": {
    "id": "inv_session_0123456789abcdef",
    "fingerprint": "sha256:..."
  }
}
```

Canonical fingerprint 涵蓋每個 selected unit 的：

- position 與 stable ID；
- kind 與 source；
- authority 與 task ID；
- lifecycle；
- recoverability 與 recovery reference；
- 排序後的 protected reasons；
- 排序後的 typed dependencies；
- token cost；
- SHA-256 content digest。

Content、order、protection、authority、recoverability、dependencies、lifecycle、source、task 或 token cost 任一變動，都會改變 fingerprint。狀態未變時重複建立 snapshot，identity 也不變。

這可阻擋 stale-plan 與 time-of-check/time-of-use 問題。若 plan 的任一 identity 欄位與 current inventory 不同，`validatePlanBinding()` 會以 `STALE_INVENTORY` 拒絕整份 plan。

## Schema

```ts
interface CompactionPlan {
  schemaVersion: 1;
  planId: string;
  inventory: {
    id: string;
    fingerprint: `sha256:${string}`;
  };
  decisions: CompactionDecision[];
}

interface CompactionDecision {
  unitId: string;
  action:
    | "KEEP"
    | "COMPRESS"
    | "EXTERNALIZE"
    | "EVICT"
    | "PROMOTE_PROPOSAL";
  importance: "critical" | "high" | "medium" | "low";
  reason: string;
  targetTokens?: number;
}
```

`targetTokens` 必須是正整數，而且只允許用於 `COMPRESS`。它是希望得到的 representation size，不是具權威性的 savings claim。

## Strict parser

`parseCompactionPlan()` 會拒絕：

- malformed JSON 或非 object plan；
- schema 任一層缺少或多出欄位；
- 不支援的 schema version；
- 格式錯誤的 plan、inventory、fingerprint 或 Context Unit ID；
- unknown action 或 importance；
- 空白或過長 reason；
- 同一 unit 的 duplicate decisions；
- 非正數或放錯 action 的 `targetTokens`；
- replacement content；
- Planner 提供的 authority、protection、recoverability、lifecycle、promotion content 或 token-savings claim。

Parser 回傳 normalized copy，不修改輸入。

## Snapshot binding

`validatePlanBinding(plan, inventory)` 做的是 protocol validation，不是 authorization：

1. strict plan schema；
2. 精確 inventory ID 與 fingerprint；
3. 每個 decision 都指向該 snapshot 中的 unit。

目前 machine-readable protocol error codes：

```text
MALFORMED_JSON
SCHEMA_VIOLATION
DUPLICATE_DECISION
INVALID_INVENTORY
STALE_INVENTORY
UNKNOWN_UNIT
```

Protection、authority、recoverability、dependency closure 與 required token reduction 都屬於 M3 authorization，仍不由本 parser 決定；其實作位於獨立的 [Runtime Validator](COMPACTION_VALIDATION.zh-TW.md)。

## Default KEEP

Plan 是 exception proposal，不擁有完整 context：

> **沒有被 Planner 提到的 Context Unit，一律 KEEP。**

`expandPlanDefaults()` 會將此規則具體化，供檢查使用。Implicit decision 的 reason 是 `UNMENTIONED_DEFAULT_KEEP`，不是 Planner claim。

空 decision list 合法，代表所有 unit 都 KEEP。

## Selection 不等於 transformation

`COMPRESS` 絕不攜帶 replacement text。未來 Transformer 才負責決定 authorized compression 的表示方式，讓 benchmark 可以區分「選錯資訊」與「summary 寫壞」。

Planner 也不能提供 `expectedTokensSaved`。M3 只依 Runtime-owned token cost 與 action rules 計算 potential reduction upper bound；actual reduction 必須等後續 transformation 與 execution 才能得知。

## Promotion 只是一項 proposal

`PROMOTE_PROPOSAL` 只含 unit ID、task-relative importance 與 reason，沒有 target、content、authority 或 persistence method。M3 Validator 將它標為 `AUDIT_ONLY`；v0.2 Phase A/B 不會寫入 project memory。

## FakePlanner

`FakePlanner` 不使用模型，實作 asynchronous Planner interface：

```js
const planner = new FakePlanner({ plan: fixturePlan });
const untrustedOutput = await planner.plan(inventoryInput);
const boundPlan = validatePlanBinding(untrustedOutput, inventorySnapshot);
```

它 deep-clone input/output 並記錄 calls 供測試；刻意不 parse、validate、authorize、execute、persist，也不接觸 Qwen。

## Test fixtures

Repository 內建固定四-unit inventory，以及以下 plan fixtures：

- 有效 KEEP、COMPRESS、EXTERNALIZE 與 PROMOTE_PROPOSAL；
- unknown unit；
- duplicate decision；
- invalid action；
- stale inventory；
- 多出的 Runtime-owned field；
- negative compression target。

Fixture inventory identity 是 hard-coded。Canonicalization 若意外改變，測試會失敗，不會靜默漂移 protocol。

## M2 邊界

M2 結束時流程停在：

```text
Inventory → FakePlanner → strict parser → binding check → expanded proposal → STOP
```

本 milestone 不包含 `compaction-validator.js`、Qwen Planner、plan retry loop、token-reduction permission、context mutation、artifact creation 或 memory promotion。

M3 authority matrix、dependency closure、fail-closed reason，以及 M4/M5 研究路線請見 [RFC-001](rfcs/RFC-001-ADAPTIVE-CONTEXT-PLANNING.zh-TW.md)。
