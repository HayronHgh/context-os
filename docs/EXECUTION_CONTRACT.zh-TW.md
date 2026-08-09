# Validated Transformation and Execution Contract

繁體中文 · [English](EXECUTION_CONTRACT.md)

版本：`0.2.0-dev.5`

狀態：D0 execution protocol 至 D5 Atomic Execution 已實作；D6 rebuild／accounting 仍不存在。

## 目的

Dev.5 在 ContextOS 執行任何 destructive context operation 前加入新的 trust boundary：

```text
ValidatedPlan
      ↓
Execution Preflight
      ↓
ExecutablePlan
      ↓
Transformation Candidate
      ↓
Post-transform Validation
      ↓
Atomic Execution
      ↓
ExecutionResult
```

目前實作在 D5 回傳 immutable committed／aborted `ExecutionResult` 後停止。D5 是這條 chain 唯一能 mutation active message context 的 layer；D6 inventory rebuild 與 actual re-tokenization 仍是獨立階段。

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
| Transformer | 哪個 candidate output 可能符合 authorized action？ |
| Post-transform Validator | Candidate 是否安全到可交給 D5？ |
| Atomic Executor | Exact validated candidate 此刻能否 atomic apply？ |

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

## D3 TransformationCandidate

`prepareTransformation()` 在任何 model call 前再次檢查 exact inventory identity，要求每個 bound unit 都具有 current Runtime content，並為每個 `ExecutablePlan` decision 產生恰好一個 immutable candidate decision。Stale identity、incomplete inventory、invalid plan、deterministic mapping error 或 COMPRESS generation failure，都會使整份 preparation 失敗；不回傳 partial candidate。

Action mapping 完全由 Runtime 固定：

| Action | Candidate operation | Model call |
| --- | --- | --- |
| `KEEP` | `NOOP` | 否 |
| `PROMOTE_PROPOSAL` | `AUDIT_ONLY` | 否 |
| `EVICT` | `REMOVE` | 否 |
| `EXTERNALIZE` | `REPLACE` canonical recovery marker | 否 |
| `COMPRESS` | `REPLACE` semantic candidate content | 是 |

`REMOVE` 與 `REPLACE` 只描述未來可能的 transformation，不會修改 active context。EXTERNALIZE marker 是由 current unit recovery reference 與已驗證的 D2 proof 產生的 canonical Runtime output；模型無法建立或修改 recovery metadata。

只有 COMPRESS 進入獨立版本的 `transformer-v1`。Payload 只包含 schema version、unit ID、kind、authority、target token request 與 source content。Isolated request 不提供 tools、關閉 thinking、使用獨立 input／output budgets 與 low temperature，且 strict JSON 只能有一個 field：

```json
{"content":"compressed candidate"}
```

Malformed JSON、schema violation 與 empty output 最多取得一次 schema-only correction。Transport failure、budget failure 或 repeated invalid output 會使整份 plan 失敗。Candidate size 在 D3 不是 error；target 與 safety acceptance 屬於 D4。

完整 source content 與每個 replacement candidate 的 SHA-256 都由 Runtime 計算，模型不提供 hash。這些 binding 讓 D4／D5 可以證明 reviewed content 就是之後準備 commit 的 content。

```ts
interface TransformationCandidate {
  schemaVersion: 1;
  candidateId: string;
  sourceExecutablePlanId: string;
  inventory: InventoryIdentity;
  status: "PREPARED";
  decisions: Array<{
    unitId: string;
    action: CompactionAction;
    operation: "NOOP" | "REMOVE" | "REPLACE" | "AUDIT_ONLY";
    sourceContentDigest: `sha256:${string}`;
    candidateContent: string | null;
    candidateContentDigest: `sha256:${string}` | null;
    requestedTargetTokens: number | null;
    candidateEstimatedTokens: number | null;
  }>;
  runtime: {
    generatedAt: string;
    zeroMutation: true;
    actualReductionTokens: null;
  };
}
```

Failure 回傳 `TRANSFORMATION_FAILED` 或 `TRANSFORMATION_STALE_INVENTORY`、`candidate: null`、`zeroMutation: true`，且沒有 partial decision list。

## D4 Post-transform Validation

`validateTransformation()` 先完成全部 Runtime-owned mechanical validation。以下檢查全數通過前，semantic validator 絕不會被呼叫：

1. candidate source ID 與 `ExecutablePlan` ID 完全相同；
2. candidate、executable plan 與 current inventory identity 相同；
3. current inventory、executable decisions、candidate decisions 對每個 unit 都恰好一次；
4. 每個 action、operation 與 requested target 都和 executable decision 相同；
5. 每個 source digest 都符合 current complete unit content；
6. 每個 candidate digest 與 token estimate 都符合 Runtime 重算；
7. deterministic operation invariants 與 canonical EXTERNALIZE marker 完全相同。

固定 operation 規則：

| Action/operation | 必須符合 |
| --- | --- |
| `KEEP / NOOP` | 沒有 candidate content、digest 或 token estimate |
| `PROMOTE_PROPOSAL / AUDIT_ONLY` | 沒有 candidate content、digest 或 token estimate |
| `EVICT / REMOVE` | 沒有 candidate content／digest；candidate tokens 必須為零 |
| `EXTERNALIZE / REPLACE` | content 完全等於 Runtime 重算的 canonical recovery marker |
| `COMPRESS / REPLACE` | 非空白；estimated tokens 必須為正、小於 current source，且不超過 requested target |

只有 mechanically valid 的 COMPRESS decision 會進入 isolated `transform-validator-v1`。Model-facing payload 只包含 original content、candidate content、kind、authority 與 protected reasons；不提供 tools、關閉 thinking，並使用獨立 budgets 與 temperature。輸出只能是：

```json
{"verdict":"ACCEPT","reasonCodes":[]}
```

或帶有下列一個以上 reason code 的 REJECT：

```text
CONSTRAINT_LOST
FACT_LOST
DECISION_LOST
IDENTIFIER_LOST
ERROR_STATE_LOST
UNRESOLVED_STATE_LOST
FABRICATION_ADDED
MEANING_CHANGED
```

Semantic model 無法修改 candidate content、核准 mechanical failure 或擴張 execution authority。任何 mechanical failure、semantic rejection、invalid semantic response、validator 缺失或 validator failure，都會拒絕整份 transformation。

成功時輸出 deep-frozen object，且刻意不複製 candidate content：

```ts
interface ValidatedTransformation {
  schemaVersion: 1;
  validationId: string;
  sourceCandidateId: string;
  inventory: InventoryIdentity;
  status: "VALIDATED";
  decisions: Array<{
    unitId: string;
    action: CompactionAction;
    operation: "NOOP" | "REMOVE" | "REPLACE" | "AUDIT_ONLY";
    permission: "APPROVED";
    sourceContentDigest: `sha256:${string}`;
    candidateContentDigest: `sha256:${string}` | null;
    validatedCandidateTokens: number | null;
  }>;
  runtime: {
    validatedAt: string;
    zeroMutation: true;
    actualReductionTokens: null;
  };
}
```

D5 同時取得這份 validation 與原始 `TransformationCandidate`，並在任何 commit 前綁定 `sourceCandidateId` 與 digests。D4 failure 回傳 `TRANSFORMATION_REJECTED`、`validatedTransformation: null`，且沒有 partial approval。

## D5 Atomic Executor

`AtomicExecutor.execute()` 完全 deterministic、model-free，要求：

```ts
{
  validatedTransformation,
  candidate,
  executablePlan,
  inventory,
  context: {
    messages,
    contextGeneration
  },
  recoveryVerifier
}
```

`ValidatedTransformation` 只是 approval metadata，不能單獨當 execution capability。任何 mutation 前，Runtime 要求以下 exact chain：

```text
validation.sourceCandidateId == candidate.candidateId
candidate.sourceExecutablePlanId == executablePlan.executablePlanId
validation.inventory == candidate.inventory
                     == executablePlan.inventory
                     == current inventory
```

每個 current Context Unit 必須在 Runtime-owned messages 中 exactly once。一般 system prompt 等未追蹤 Runtime message 保持不變。每個 tracked unit 都由 Runtime 重算 current source SHA-256，並同時比對 D3 與 D4；每個 REPLACE operation 也重新 hash exact `candidate.candidateContent`，比對 D3／D4 candidate digest。

### Fresh recovery 與 TOCTOU gate

D2 recovery proof 是 point-in-time evidence，不是 lease。D5 在 commit 前立即為所有 destructive action 重跑 `RecoveryVerifier`：

```text
EVICT
EXTERNALIZE
COMPRESS
```

D2 `VERIFIED` decision 此刻仍必須是 `VERIFIED`；合法的 no-recovery-claim decision 此刻仍必須是 `NOT_REQUIRED`。Source 消失、provider failure、integrity drift、verification throw 或 classification 改變，都會 abort 整份 execution。

Commit target 提供 monotonically increasing `contextGeneration`。D5 在 asynchronous recovery checks 前保存 generation 與 message-array reference，回來後要求兩者完全不變，並在最後一個 `await` 後重跑完整 chain 與 content bindings。任何 drift 都回傳 `EXECUTION_STALE_CONTEXT`。

### Clone、build、validate、swap

D5 不會逐 decision 修改 live array，而是將所有 operation 套用到完整 clone：

| Operation | Commit behavior |
| --- | --- |
| `NOOP` | 完整保留原 message |
| `AUDIT_ONLY` | 完整保留原 message；不寫 memory |
| `REMOVE` | 只省略 exact bound source message |
| `REPLACE` | 將 content 設為 exact validated `candidate.candidateContent` |

完整 next context 必須維持有效的 assistant tool-call／result structure。只有 clone/build 與所有 pre-commit checks 成功後，D5 才 synchronously 替換 Runtime-owned message-array reference 並增加 `contextGeneration`；critical section 內沒有 `await`。

每個 `validationId` 在其 `AtomicExecutor` 內只能使用一次，in-flight reuse 也 fail closed。Successful context commit 與 validation consumption 位於同一個 synchronous critical section；第二次 execution 回傳 `EXECUTION_ALREADY_CONSUMED`。

### ExecutionResult

成功回傳 deep-frozen result：

```ts
interface ExecutionResult {
  schemaVersion: 1;
  executionId: string;
  sourceValidationId: string;
  status: "COMMITTED";
  inventoryBefore: InventoryIdentity;
  operations: Array<{
    unitId: string;
    operation: "NOOP" | "REMOVE" | "REPLACE" | "AUDIT_ONLY";
  }>;
  committed: true;
  runtime: {
    committedAt: string;
    contextGenerationBefore: number;
    contextGenerationAfter: number;
  };
}
```

失敗回傳 `status: "EXECUTION_ABORTED"`、`committed: false`、immutable diagnostic checks，以及一個或多個 bounded reason codes：

```text
INVALID_VALIDATED_TRANSFORMATION
EXECUTION_CHAIN_MISMATCH
EXECUTION_STALE_CONTEXT
SOURCE_CONTENT_CHANGED
CANDIDATE_CONTENT_CHANGED
RECOVERY_REVALIDATION_FAILED
EXECUTION_ALREADY_CONSUMED
EXECUTION_BUILD_FAILED
EXECUTION_COMMIT_FAILED
```

Executor failure 不會暴露 prepared clone，也不會 partial apply operation。

## Failure result

任一 gate failure 都回傳：

```text
status: EXECUTION_PRECONDITION_FAILED
executablePlan: null
zeroMutation: true
```

Preflight reason codes 包含 invalid shape、invalid／stale current inventory、insufficient／rejected plan、fallback requirement、decision／inventory mismatch、unauthorized decision 與 recovery failure codes。

## Zero-mutation boundary

D0-D4 明確排除：

- message 或 Context Unit mutation；
- artifact、project-memory 或 episode write；
- lifecycle 或 authority mutation；
- inventory rebuild；
- actual re-tokenization 或 actual-reduction claim。

這些保證完整維持至 D4。D5 只有在所有 gates 通過後，才能替換 active message-array reference；仍不會執行 artifact、memory、lifecycle、authority、inventory 或 accounting write。

## 剩餘 dev.5 sequence

```text
D6  Inventory rebuild + actual re-tokenization + ExecutionReport
```

D6 必須從 committed messages rebuild Context Inventory、執行 actual re-tokenization、計算 actual reduction，並附加 measurement，但不能改變 D5 authorization boundary。
