# Compaction Authorization

繁體中文 · [English](COMPACTION_VALIDATION.md)

版本：`0.2.0-dev.3`

狀態：M3 Runtime Validator 已實作；尚無 transformation 與 execution。

## 目的

Runtime Validator 將不可信的 `CompactionPlan` proposal 轉換成不同 type 的 `ValidatedPlan`。Proposal 永遠不等於 permission。Validation 是 deterministic、model-free、無 side effect，且在任何 context、artifact、lifecycle、authority 或 memory mutation 之前停止：

```text
CompactionPlan
      ↓
Runtime Validator
      ↓
ValidatedPlan
      ↓
STOP
```

公開 module 是 `src/compaction-validator.js`，主要入口：

```js
validateCompactionAuthorization({
  plan,
  inventory,
  pressure
})
```

`inventory` 是 plan 所綁定的 Runtime-owned snapshot；`pressure.requiredReductionTokens` 同樣由 Runtime 擁有。

## ValidatedPlan

Validator 回傳全新物件，不修改 plan 或 inventory：

```ts
interface ValidatedPlan {
  schemaVersion: 1;
  planId: string | null;
  inventory: { id: string; fingerprint: string } | null;
  status:
    | "AUTHORIZED_DEFINITELY_INSUFFICIENT"
    | "AUTHORIZED_POTENTIALLY_SUFFICIENT"
    | "REJECTED";
  reasonCodes: PlanReasonCode[];
  decisions: ValidatedDecision[];
  runtime: {
    requiredReductionTokens: number | null;
    potentialReductionUpperBound: number;
    actualReductionTokens: null;
    fallbackRequired: boolean;
  };
}

interface ValidatedDecision {
  unitId: string;
  proposedAction: CompactionAction;
  permission: "AUTHORIZED" | "REJECTED" | "AUDIT_ONLY";
  reasonCodes: DecisionReasonCode[];
  importance: "critical" | "high" | "medium" | "low" | null;
  requestedTargetTokens: number | null;
  potentialReductionUpperBound: number;
  replacementCostUnknown: boolean;
}
```

Rejected action 仍以 rejected proposal 保留，不會被靜默改寫為 `KEEP`。未提到的 unit 仍會先展開為 implicit `KEEP` 再進行 authorization。

## Authorization precedence

Runtime 依下列順序套用 gate：

```text
Protection
    ↓
Authority
    ↓
Recoverability
    ↓
Dependency closure
    ↓
Planner recommendation
```

Planner 提供的 `importance` 只保留供 audit，無法 override 任何 Runtime gate。

### Protection

| Protected unit 的 proposed action | Permission |
| --- | --- |
| `KEEP` | `AUTHORIZED` |
| `PROMOTE_PROPOSAL` | `AUDIT_ONLY` |
| `COMPRESS` | `REJECTED / PROTECTED_UNIT` |
| `EXTERNALIZE` | `REJECTED / PROTECTED_UNIT` |
| `EVICT` | `REJECTED / PROTECTED_UNIT` |

M3 不提供 protected-unit compression 的 safety-certified exception。

### Authority policy

`AUTHORIZATION_POLICY` 是 frozen Runtime-owned table：

| Authority | KEEP | COMPRESS | EXTERNALIZE | EVICT |
| --- | --- | --- | --- | --- |
| `USER` | 允許 | unprotected 時允許 | 需要 recoverable | 需要 recoverable |
| `SOURCE_OF_TRUTH` | 允許 | unprotected 時允許 | 需要 repository recovery | 需要 recoverable |
| `EVIDENCE` | 允許 | 需要 durable recovery | 需要 recoverable | 需要 durable recovery |
| `DERIVED` | 允許 | unprotected 時允許 | 需要 recoverable | 需要 recoverable |
| `SPECULATIVE` | 允許 | unprotected 時允許 | 需要 recoverable | 需要 recoverable |

`PROMOTE_PROPOSAL` 另外處理，永遠是 `AUDIT_ONLY / UNSUPPORTED_PROMOTION`；不寫 memory、不改 authority 或 lifecycle，也不移動 active context。

### Recoverability

Exported predicates 明確固定第一版 policy：

| Recoverability | `isRecoverable()` | `isDurablyRecoverable()` |
| --- | ---: | ---: |
| `artifact` | 是 | 是 |
| `repository` | 是 | 是 |
| `memory` | 是 | 是 |
| `rebuildable` | 是 | 否 |
| `none` | 否 | 否 |

Rebuildable evidence 不等於 durable exact-enough evidence。因此 `EVIDENCE + rebuildable + EVICT` 必須拒絕。

## Dependency safety

M3 只把 `depends_on` 當成 hard retention edge。Action authorization 前先完成 graph validation：

```text
build graph
    ↓
validate targets
    ↓
detect cycles
    ↓
compute transitive closure
    ↓
authorize decisions
```

Missing target 以 `MISSING_DEPENDENCY` 拒絕 whole plan；cycle 以 `DEPENDENCY_CYCLE` 拒絕。兩者都要求 deterministic fallback。

Dependency safety 依 post-action availability 判斷，不是只看 unit 是否仍在 prompt：

| Action | Availability |
| --- | --- |
| `KEEP` | `ACTIVE` |
| `COMPRESS` | `ACTIVE_TRANSFORMED` |
| 有 recovery 的 `EXTERNALIZE` | `RECOVERABLE` |
| 有 recovery 的 `EVICT` | `RECOVERABLE` |
| 無 recovery 的 `EVICT` | `UNAVAILABLE` |
| `PROMOTE_PROPOSAL` | `ACTIVE` |

若 active unit 直接或 transitively 需要某 unit，而 proposal 會讓該 target unavailable，target proposal 會以 `ACTIVE_DEPENDENCY` 拒絕。可恢復的 externalized／evicted dependency 仍屬 available。

## Token accounting

M3 只報告符合 epistemic boundary 的數值：

```text
requiredReductionTokens
= Runtime 要求

potentialReductionUpperBound
= execution 前 M3 能證明的 gross 最大 reduction

actualReductionTokens
= null
```

各 action upper bound：

| Action | Potential upper bound |
| --- | ---: |
| `KEEP` | `0` |
| `PROMOTE_PROPOSAL` | `0` |
| `COMPRESS` | `unit.tokens - targetTokens` |
| `EXTERNALIZE` | `unit.tokens` gross upper bound |
| `EVICT` | `unit.tokens` gross upper bound |

只有 `0 < targetTokens < unit.tokens` 才授權 `COMPRESS`，否則以 `INVALID_COMPRESSION_TARGET` 拒絕。`EXTERNALIZE` 與 `EVICT` 會標示 `replacementCostUnknown: true`，因為未來 marker 或 recovery reference 仍可能占用 token。

Plan status：

| 條件 | Status | Fallback |
| --- | --- | ---: |
| 任一 plan／decision rejection | `REJECTED` | 是 |
| authorized upper bound 小於 Runtime 要求 | `AUTHORIZED_DEFINITELY_INSUFFICIENT` | 是 |
| authorized upper bound 大於或等於要求 | `AUTHORIZED_POTENTIALLY_SUFFICIENT` | 否 |

最終狀態不宣稱 reduction 已實際 sufficient。只有 execution 與 post-transform measurement 能證明 actual saving。

## Reason codes

Plan-level：

```text
STALE_INVENTORY
UNKNOWN_UNIT
DUPLICATE_DECISION
MISSING_DEPENDENCY
DEPENDENCY_CYCLE
FAILURE_ENVELOPE_RISK
```

Decision-level：

```text
PROTECTED_UNIT
AUTHORITY_VIOLATION
NON_RECOVERABLE
ACTIVE_DEPENDENCY
UNSUPPORTED_PROMOTION
INVALID_ACTION
INVALID_COMPRESSION_TARGET
```

Malformed schema 與 invalid Runtime pressure 會封裝為 `FAILURE_ENVELOPE_RISK`，不會讓 exception 逸出並被誤認為 permission。

## Purity 與 non-goals

Tests 驗證重複 validation deterministic，且 plan、inventory、messages、project memory、episodes 與 artifact observations 全部不變。Validator 不 import model、llama.cpp client、memory store、tool evidence writer 或 context executor。

M3 明確不提供：

- replacement 或 summary content；
- context mutation；
- artifact creation；
- memory promotion 或 persistent write；
- lifecycle 或 authority change；
- Qwen Planner integration；
- actual token-reduction measurement；
- frozen deterministic `context-manager.js` policy 修改。

下一個安全邊界仍然是 authorization → future transformation → post-transform validation → execution。
