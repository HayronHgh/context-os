# Host Context Bridge

繁體中文 · [English](HOST_CONTEXT_BRIDGE.md)

Host Context Bridge 補上 ContextOS policy 與 llama.cpp browser transcript 之間的缺口。MCP 能提供工具能力，但 MCP 本身不能取代 browser 擁有的 message array。因此 Bridge 會在 inference 開始前，對每次送出的 request 副本執行 bounded preflight。

## Runtime 拓樸

```text
llama.cpp b10295 Web UI（browser 保有完整 IndexedDB 歷史）
        |
        | 將 request 副本 POST 到 /v1/context/prepare
        v
ContextOS Host Bridge：127.0.0.1:8181
        |
        | pressure accounting；必要時執行 isolated state transfer
        v
prepared message array
        |
        | 原 Web UI 再 POST /v1/chat/completions
        v
llama.cpp：127.0.0.1:8080 -> Qwen

llama.cpp MCP Host -> ContextOS stdio MCP -> repository/memory/evidence tools
```

Bridge 不是 inference proxy，也不擁有持久對話歷史。Browser 內原始 transcript 完整保留；只有實際送給模型的 request representation 可能被壓縮。

## Request contract

修改後的官方 Web UI 會傳入：

```json
{
  "schemaVersion": 1,
  "conversationId": "browser-conversation-id",
  "messages": [],
  "tools": [],
  "maxOutputTokens": 16384
}
```

Bridge 會驗證 schema、把完整 tool definitions 納入 pressure accounting，並計算 SHA-256 request identity。完全相同的 request 會使用同時限制 entry count 與 bytes 的記憶體 cache。回應狀態只會是 `UNCHANGED` 或 `PREPARED`，並附上壓縮前後估算與實際 actions。

## 自動壓縮行為

有效預算是 `contextWindow - reservedOutputTokens`。使用附帶的 64K/16K 設定時，semantic preparation 會在 49,152 input-token 預算的 72% 啟動，遠早於 llama.cpp prompt 到達 65,535 tokens。

既有 ContextManager 階段維持不變：

1. 55%：只有存在 durable recovery 時，才清理舊 tool output。
2. 65%：只有每份結果都可復原時，才移除完整的舊 tool exchange。
3. 72%：替舊 turns 產生通過 schema 驗證的 Coding State Transfer。
4. 80%：只保留最新 user work window 與 state transfer。
5. 90%：prepared request 仍放不下時 fail closed。

State transfer 是 isolated、tool-free 的呼叫。模型必須回傳完全符合規格的 state schema，最多允許一次修正；它不能修改 browser transcript。若 preparation 失敗或最終仍超過 failure boundary，Web UI 不會再把危險 request 送進 completion slot。

llama.cpp 原生 context shift 保持啟用，作為最後一道 Runtime 保險；它不是主要 semantic policy。

## 寫入能力

Bridge 與 MCP capability mode 是兩個獨立邊界。若要公布檔案 mutation tools，請在 Git 忽略的本機 `config/mcp.json` 顯式使用 `trusted-local`，除非確實需要，否則保持 command execution 關閉：

```json
{
  "projectRoot": "../workspace",
  "mode": "trusted-local",
  "security": {
    "allowCommands": false,
    "commandTimeoutSeconds": 120
  }
}
```

這會公布 `write_file` 與 `edit_file`，同時保留 real-path project containment、destructive-command checks 與 evidence handling。提交到 Git 的預設仍是 read-only。`projectRoot` 必須指向真正要操作的 repository，不可設成整個使用者目錄或磁碟根目錄。

## 建置 exact UI overlay

使用 llama.cpp tag `b10295`，然後執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-host-ui.ps1 `
  -LlamaUiSource C:\path\to\llama.cpp\tools\ui
```

腳本只會對 `ChatService.sendMessage` 套用狹窄且有 anchor check 的 patch，依 upstream lockfile 安裝套件，把官方 static UI 建置到 Git 忽略的 `host-ui/`，並加入 `contextos-host-bridge.json`。若 upstream request anchors 改變，腳本會直接拒絕猜測式修改。

## 一鍵生命週期

`START.bat` 會依序啟動 Bridge、llama.cpp、其 stdio MCP child，並驗證：

- `http://127.0.0.1:8181/health` 的 Bridge identity；
- llama.cpp health；
- MCP tool list；trusted-local 時必須包含 write/edit；
- llama.cpp 實際提供的 integrated UI marker。

`STOP.bat` 經過 process identity check 後，只停止本 checkout 記錄的 llama.cpp 與 Bridge PID。Logs 在 `logs/`，PID files 在 `runtime/`。

## 安全邊界

- Bridge 只綁定 loopback。
- Browser CORS origins 使用明確 allowlist。
- Request body 有大小上限。
- Origin、schema、state transfer 或最終 pressure 任一不合法都 fail closed。
- Browser 保留 authoritative full transcript。
- Bridge 不取得 repository tool authority；repository authority 仍由 MCP policy 管理。
- Static overlay 固定並檢查 llama.cpp b10295。

這是包住既有 ContextManager 的 Host adapter，不會改動凍結的 M2/M3 planner authorization 或 D0-D6 atomic execution contracts。
