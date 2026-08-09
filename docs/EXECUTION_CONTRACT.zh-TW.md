# Validated Transformation and Execution Contract

繁體中文 · [English](EXECUTION_CONTRACT.md)

版本：`0.2.0-dev.5`

狀態：D0 execution protocol、D1 RecoveryVerifier、D2 ExecutionPreflight 已實作；尚無 transformation 與 mutation。

## 目的

Dev.5 在 ContextOS 執行任何 destructive context operation 前加入新的 trust boundary：

```text
ValidatedPlan
      ↓
Execution Preflight
      ↓
ExecutablePlan
      ↓
Transformation Candidate       （未實作）
      ↓
Post-transform Validation      （未實作）
      ↓
Atomic Execution               （未實作）
      ↓
ExecutionReport                （未實作）
```

第一階段實作停在 `ExecutablePlan`，不 transform、也不 mutation context。

## 核心 invariants

```text
ValidatedPlan != ExecutablePlan

M3 recoverability classification
!= execution-time recovery proof

COMPRESS authorization
!= authorization of arbitrary replacement content
```

各 layer 回答不同問題：

| Layer | 問題 |
| --- | --- |
| M3 Validator | Policy 是否允許嘗試此 action？ |
| RecoveryVerifier | Runtime recovery claim 此刻是否成立？ |
| ExecutionPreflight | 完整 current plan 是否可繼續？ |
| Future Transformer | 哪個 candidate output 可能符合 authorized action？ |
| Future post-transform Validator | Candidate 是否安全到可 commit？ |
| Future Executor | 已驗證 candidate 能否 atomic apply？ |

後層不得把前層 permission 解讀成更大的 authority。

## M4 frozen experiment identity

`config/m4-freeze.json` 固定 `aa59f4d` baseline，並記錄以下檔案的 SHA-256：

- `planner-v1`；
- PlannerInventoryView selection 與 budgets；
- M2 CompactionPlan protocol；
- M3 authorization policy；
- PAR／IPR 與 Planner telemetry semantics。

`test/m4-freeze.test.js` 會在這些 inputs 漂移時失敗。未來 prompt 若要修改，必須建立 `planner-v2` 等新 identity，不得暗改 `planner-v1`。

Manifest 也固定 Qwen retry／binding behavior 與 semantic proposal orchestration，因為即使 prompt text 不變，這些內容仍會決定 experiment identity 與 telemetry meaning。

## ExecutionPreflight admission gate

`preflightValidatedPlan()` 只接受符合以下條件、由 Runtime 產生的 strict `ValidatedPlan`：

1. 完整符合 ValidatedPlan schema version 1；
2. inventory ID／fingerprint 與 current inventory 完全一致；
3. current inventory 每個 unit 恰好有一個 decision；
4. status 是 `AUTHORIZED_POTENTIALLY_SUFFICIENT`；
5. `fallbackRequired: false`；
6. 沒有 rejected decision；
7. `actualReductionTokens: null`；
8. 所有 required current-source recovery check 都通過。

Insufficient 或 rejected plan 不可局部執行。Preflight 不會從 failed plan 中挑出看似安全的 decisions 執行。

## Recovery proof requirement

只有 destructive action 帶有非 `none` recovery claim 時，Runtime 才要求 proof：

```text
COMPRESS | EXTERNALIZE | EVICT
and
recoverability != none
      ↓
current-source proof required
```

對某些 authority，M3 可授權 non-recoverable `COMPRESS`。此時 proof status 為 `NOT_REQUIRED`，因為沒有 recovery claim；但未來 transformation output 仍必須通過獨立 post-transform validation，才可能進入 mutation。

`KEEP` 與 audit-only `PROMOTE_PROPOSAL` 不需要 recovery proof，也不能成為 destructive execution step。

## RecoveryVerifier

`RecoveryVerifier` 取得 cloned unit／reference data，並依 Runtime-owned recoverability type 呼叫一個 read-only provider：

| Type | Required reference | Verification |
| --- | --- | --- |
| `artifact` | `artifactId` | artifact 存在；stored content integrity 正確；optional reference SHA-256 相符 |
| `repository` | project-relative `path` | real path 仍在 project 內；file 存在；量測 current SHA-256；optional expected SHA-256 相符 |
| `memory` | `stateKey` 或 `episodeId` | referenced durable state 仍存在 |
| `rebuildable` | `mechanism` | named reconstruction mechanism 目前已註冊 |
| `none` | 無 | 沒有 recovery claim 需要證明 |

Provider 不存在、reference 缺失、path escape、source 缺失、integrity drift、provider evidence 無效或 verification throw，全部 fail closed。

`RecoveryProof` 是 point-in-time admission evidence，不是 lease，也不是永久 capability。D5 必須在 commit 前立即重跑 preflight，或以 atomic 方式將 fresh inventory／source binding 與 proof 比對。`ExecutablePlan` 僅能 single-use；binding 一旦改變就必須 fail closed，不得快取後延遲執行。

## RecoveryProof

每個 decision 都取得 deep-frozen proof result：

```ts
interface RecoveryProof {
  schemaVersion: 1;
  unitId: string;
  action: CompactionAction;
  sourceType: "artifact" | "repository" | "memory" | "rebuildable" | "none";
  checkedAt: string;
  status: "VERIFIED" | "NOT_REQUIRED" | "FAILED";
  code: RecoveryFailureCode | null;
  detail: string | null;
  evidence: object | null;
}
```

Proof evidence 只包含 identifier、hash、size、path 或 mechanism name，不會把 recovered content 複製到 execution plan。

Machine-readable failure codes：

```text
RECOVERY_REFERENCE_MISSING
RECOVERY_PROVIDER_UNAVAILABLE
RECOVERY_SOURCE_NOT_FOUND
RECOVERY_SOURCE_INVALID
RECOVERY_INTEGRITY_MISMATCH
RECOVERY_VERIFICATION_FAILED
```

## ExecutablePlan

只有完整成功的 preflight 才產生此 distinct、deep-frozen object：

```ts
interface ExecutablePlan {
  schemaVersion: 1;
  executablePlanId: string;
  sourceValidatedPlanId: string;
  inventory: InventoryIdentity;
  status: "EXECUTABLE";
  decisions: Array<{
    unitId: string;
    action: CompactionAction;
    executionDisposition: "READY" | "NOOP" | "AUDIT_ONLY";
    importance: CompactionImportance | null;
    requestedTargetTokens: number | null;
    potentialReductionUpperBound: number;
    recoveryProof: RecoveryProof;
  }>;
  runtime: {
    checkedAt: string;
    requiredReductionTokens: number;
    potentialReductionUpperBound: number;
    actualReductionTokens: null;
    zeroMutation: true;
  };
}
```

它不包含 replacement content、transformed messages、artifact write、memory write、mutation callback，或超出 named decisions 的 execution authority。

## Failure result

任一 gate failure 都回傳：

```text
status: EXECUTION_PRECONDITION_FAILED
executablePlan: null
zeroMutation: true
```

Preflight reason codes 包含 invalid shape、invalid／stale current inventory、insufficient／rejected plan、fallback requirement、decision／inventory mismatch、unauthorized decision 與 recovery failure codes。

## Zero-mutation boundary

D0-D2 明確排除：

- Transformer 或 model call；
- TransformationCandidate 或 replacement content；
- post-transform approval；
- message 或 Context Unit mutation；
- artifact、project-memory 或 episode write；
- lifecycle 或 authority mutation；
- inventory rebuild；
- actual re-tokenization 或 actual-reduction claim。

除了測試在 temporary directory 建立普通 fixture，本實作完全 read-only。

## 剩餘 dev.5 sequence

```text
D3  Transformer -> TransformationCandidate
D4  Post-transform Validator
D5  Atomic Executor
D6  Inventory rebuild + actual re-tokenization + ExecutionReport
```

D3 必須只定義 candidate schema，不提供 write authority；D4 必須獨立驗證 candidate output；D5 才是第一個可 mutation active context 的 stage。
