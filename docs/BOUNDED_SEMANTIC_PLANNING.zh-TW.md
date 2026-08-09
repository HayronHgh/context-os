# Bounded Semantic Proposal Generation

繁體中文 · [English](BOUNDED_SEMANTIC_PLANNING.md)

版本：`0.2.0-dev.4`

狀態：M4 semantic proposal generation 已實作；尚無 transformation 與 execution。

## 研究邊界

M4 只回答一個問題：

> Qwen 能否依 bounded Runtime inventory 產生有價值且符合 policy 的 `CompactionPlan` proposal？

它不測試執行 proposal 後 context 是否改善。實作 pipeline：

```text
Context Inventory
      ↓
Planner Input Builder
      ↓
Bounded Semantic Planner
      ↓
isolated Qwen call（無 tools）
      ↓
raw model output
      ↓
strict CompactionPlan parser
      ↓
inventory + visibility binding
      ↓
Runtime Validator
      ↓
ValidatedPlan
      ↓
STOP
```

M4 不修改 context、不建立 artifact、不寫 memory、不改 lifecycle／authority、不 transform unit、不宣稱 actual token saving，也不修改 frozen ContextManager／Validator policy。

## Modules

| Module | 責任 |
| --- | --- |
| `src/planners/planner-input.js` | deterministic bounded `PlannerInventoryView` |
| `src/planners/planner-prompt.js` | 固定且可 benchmark 的 `planner-v1` prompt |
| `src/planners/qwen-planner.js` | isolated model call、strict parsing、一次 correction |
| `src/semantic-proposal.js` | binding → Runtime Validator → STOP orchestration |
| `src/planner-observability.js` | session audit adapter 與 proposal metrics |

`QwenPlanner.plan(input)` 回傳 `CompactionPlan`，永遠不是 `ValidatedPlan`。Runtime Validator 仍是唯一 permission authority。

## Bounded Planner input

Planner 不會收到正常 Agent conversation 或 raw transcript。`buildPlannerInput()` 使用 internal inventory snapshot，只輸出 Runtime facts 與 bounded representations：

```json
{
  "schemaVersion": 1,
  "plannerPromptVersion": "planner-v1",
  "requestedPlanId": "plan_...",
  "inventory": {
    "id": "inv_...",
    "fingerprint": "sha256:..."
  },
  "pressure": {
    "ratio": 0.74,
    "requiredReductionTokens": 2000
  },
  "task": {
    "objective": "...",
    "phase": "investigation"
  },
  "stats": {
    "totalUnits": 24,
    "totalTokens": 43200,
    "protectedUnits": 7,
    "recoverableUnits": 13
  },
  "visibleUnitIds": ["cu_..."],
  "units": []
}
```

每個 visible unit 包含 stable ID、position、kind、authority、token cost、recoverability、protection、dependencies、lifecycle 與 deterministic representation。Runtime metadata 是 authoritative，模型不能取代或重新計算。

### Multi-tier representation

- content 不超過 `fullUnitChars` 時完整顯示；
- 大型 content 使用 deterministic head／middle omission／tail，並受 `maxUnitChars` 限制；
- Planner 前不呼叫另一個 model summarizer；
- 不會因 unit 很大就傳入 full content。

### Global budget

第一版 defaults：

```json
{
  "maxInputTokens": 12000,
  "maxOutputTokens": 2048,
  "maxVisibleUnits": 64,
  "fullUnitChars": 600,
  "maxUnitChars": 1000,
  "maxTaskChars": 1000,
  "temperature": 0.1,
  "maxAttempts": 2
}
```

`maxInputTokens` 限制完整 system + user request，並替一次 correction instruction 保留空間。Input token estimation 使用 Runtime 的保守 UTF-8 approximation；若 metadata 本身無法放入，model call 前就會失敗。

### Deterministic visibility selection

無法放入全部 unit 時，使用 stable lexicographic ranking：

1. protected units；
2. `USER` authority；
3. active lifecycle；
4. `depends_on` targets 與 dependency roots；
5. unresolved errors／hypotheses；
6. 其餘依 inventory position 與 stable ID。

這是 safety envelope，不是 semantic planning。Hidden unit 不會被視為可拋棄；不在 `visibleUnitIds` 的 unit 不能收到 explicit decision，因此依 M2 protocol 自然成為 implicit `KEEP`。

## Isolated Qwen call

`QwenPlanner` 送出 stateless request，內容只有：

```text
system: 固定 planner-v1 prompt
user: bounded PlannerInventoryView JSON
```

此 call 具有：

- `tools: []`；
- 透過 llama.cpp chat-template kwargs 關閉 thinking；
- fixed low temperature；
- fixed output-token budget；
- JSON object response format；
- 無正常 coding messages；
- 無 write、memory、artifact 或 Runtime capability。

只有 `message.content` 會被視為 proposal output。Hidden reasoning 不會回灌正常 conversation，telemetry 也不依賴它。

Frozen `planner-v1` prompt 明列完整 decision enum 與 scalar 規則：action values、`importance` values（`critical`、`high`、`medium`、`low`）、非空白 `reason`，以及只可用於 `COMPRESS` 的 positive-integer `targetTokens`。Strict parser 仍是最終 authority。

## Strict output 與 retry

Raw output 一律不可信。Adapter 可移除一層 enclosing JSON code fence，但不修 JSON、不改寫 field，接著套用：

1. strict M2 `parseCompactionPlan()`；
2. exact `requestedPlanId` challenge；
3. exact inventory identity；
4. `decision.unitId ∈ visibleUnitIds`。

`PLAN_UNIT_NOT_VISIBLE` 防止模型對 bounded view 之外的真實 unit 採取 action。

Retry 固定為：

| Failure | 行為 |
| --- | --- |
| malformed/schema/duplicate decision | 一次 correction |
| plan ID 錯誤 | 一次 correction |
| non-visible unit | 一次 correction |
| transient client error | 一次 correction |
| stale inventory | 立即 discard；不可用 stale input retry |
| 兩次失敗 | `PLANNER_FAILED` + deterministic fallback |
| Validator rejection | STOP + fallback；不 autonomous replan |

Correction message 只包含 machine-readable error code／path，不包含 invalid raw output。

## Audit 與 metrics

`createPlannerSessionAudit(memory)` 透過既有 session JSONL channel 寫入 Planner events，不呼叫 project-memory 或 episode API。

Attempt event 記錄 prompt version、inventory identity、每次 request 的 estimated／observed tokens、visible／hidden unit counts、attempt、parse result、latency、error code、failure category 與 raw final-output content。Binding／visibility／stale failure 的 parse result 為成功；client failure 則標示 parsing 未執行。Event 不記錄 hidden reasoning。

Result-level `PlannerInputTokens`、`PlannerOutputTokens` 與 `PlannerLatencyMs` 會累計所有 Planner attempts。發生一次 correction 時，experiment cost 會反映兩次 request 的總成本，而不是只回報成功的 request。

Failure telemetry 分開記錄 `failedAttempts` 與以下分類：

| Category | 意義 |
| --- | --- |
| `protocolFailures` | malformed JSON、schema／duplicate violation 或 empty output |
| `bindingFailures` | Runtime plan-ID challenge mismatch |
| `visibilityFailures` | 對 `visibleUnitIds` 之外的 unit 提出 decision |
| `clientFailures` | model transport／client failure |
| `staleFailures` | proposal 綁定 stale inventory identity |

`parseFailures` 保留為較窄的計數，只包含 malformed JSON、schema violation 與 duplicate decision；不包含 binding、visibility、client 或 stale failure。

Result metrics：

```text
PlannerInputTokens
PlannerOutputTokens
PlannerLatencyMs
VisibleUnits / HiddenUnits
ExplicitDecisions / ImplicitKeeps
ParseAttempts / ParseFailures
FailedAttempts
ProtocolFailures / BindingFailures / VisibilityFailures
ClientFailures / StaleFailures
AuthorizedDecisions / RejectedDecisions / AuditOnlyDecisions
RejectionReasonDistribution
PotentialReductionUpperBound / RequiredReductionTokens
```

Proposal Authorization Rate：

```text
authorized explicit decisions / explicit non-audit decisions
```

Illegal Proposal Rate：

```text
rejected explicit decisions / explicit non-audit decisions
```

M4 沒有 execution，因此不回報 PILR、WIR、SCU 或 actual context gain。

## Failure 與 purity guarantees

- Parser／binding／visibility failure 永遠不會變成 permission。
- Stale snapshot 不會以舊 input 修復。
- Validator rejection 不啟動 agentic retry loop。
- Hidden units 維持 implicit `KEEP`。
- Planner telemetry 是 experimental session evidence，不是 semantic memory。
- Plan、inventory、messages、memory、episodes、artifacts、authority 與 lifecycle 全部不變。

## M4 smoke test

`npm run test:m4:e2e` 會把六個 unit 的 synthetic inventory 送給已設定的 llama.cpp + Qwen model。它不 assert 精確 semantic choice，只檢查 parseability、binding、visible-only decisions、structurally valid Runtime authorization、無 mutation，最後印出：

```text
V020_M4_E2E_OK
```

## Future execution invariant

M3 authorization 證明的是 policy eligibility，不是 recovery source 此刻仍存在。dev.5 執行前必須重新驗證所選 recovery path：

```text
ValidatedPlan
      ↓
Recovery Source Revalidation
      ├─ artifact：存在 + integrity
      ├─ repository：current path/source valid
      ├─ memory：referenced state exists
      └─ rebuildable：rebuild mechanism available
      ↓
Transform
      ↓
Post-transform validation
      ↓
Execution + inventory rebuild + re-tokenization
```

任何 revalidation failure 都必須 abort execution 並選擇 deterministic fallback。
