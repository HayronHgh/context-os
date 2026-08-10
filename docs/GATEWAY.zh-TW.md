# Runtime Chat Gateway

繁體中文 · [English](GATEWAY.md)

## 目的

Runtime Chat Gateway 將既有 CLI Runtime 變成可從瀏覽器操作的本機 Agent，同時不讓 Browser 成為 conversation state 的擁有者。

```text
Browser :8787
    ↓ HTTP + SSE
RuntimeSession
    ↓ 每個 session 獨佔一個 AgentRuntime
tools · evidence · memory · deterministic context management
    ↓ 共用 LlamaClient
llama-server :8080
    ↓
Qwen
```

llama.cpp 仍是推論 backend。Gateway 不代理 llama.cpp 內建 UI，也不啟用 llama.cpp 內建 filesystem tools。

## 啟動

一般使用建議一鍵啟動：

```bat
START_ALL.bat "C:\path\to\your\repository"
```

它會依序啟動 llama-server、確認 Gateway 將為每個 Browser session 建立 AgentRuntime、啟動 Gateway、檢查兩個 health endpoint，最後開啟 Browser。使用 `STOP_ALL.bat` 依安全順序停止 Gateway、其 Runtime sessions 與 llama-server。

也可以個別啟動。先啟動模型：

```text
01_start_server.bat
```

再啟動瀏覽器 Runtime：

```bat
03_start_gateway.bat "C:\path\to\your\repository"
```

它會在 `http://127.0.0.1:8787` 啟動只接受 loopback 的 HTTP server，並開啟瀏覽器。使用 `06_stop_gateway.bat` 停止。

不要針對同一個 project 同時啟動 `02_start_agent.bat` 與 Gateway。該檔案是替代用的 terminal UI；Browser 所需的 AgentRuntime 已由 Gateway 建立。

等價的終端指令是：

```powershell
npm run gateway -- --project "C:\path\to\your\repository"
```

## Source-of-truth 邊界

每次 `POST /api/sessions` 都會建立恰好一個 `RuntimeSession`、一個 `AgentRuntime`、一份 message history、一個 Context Inventory registry，以及一個 project-local `MemoryStore`。只有 `LlamaClient` 與 llama-server process 共用。由於 file-based MemoryStore 沒有 cross-session transaction lock，同一 canonical project root 同一時間只允許一個 active session。

Browser 只保存 presentation state，不會把 `messages[]` transcript 送回 Runtime。每輪只提供新的 user message：

```json
{
  "content": "檢查 src/agent-runtime.js，並引用檔案證據。"
}
```

因此 Browser history 無法繞過 Runtime pruning、durable evidence、recovery reference 或 context generation。

## API

### 建立 session

```http
POST /api/sessions
Content-Type: application/json
```

```json
{
  "projectRoot": "C:\\path\\to\\repository"
}
```

目錄必須已存在。Session 建立時會透過既有 `MemoryStore` 初始化 `.qwen-agent/`，並檢查 llama-server health。

### 執行一輪

```http
POST /api/sessions/:id/turn
Content-Type: application/json
```

每個 session 同一時間只能執行一輪；並行請求會回傳 `409 SESSION_BUSY`。

### 觀察事件

```http
GET /api/sessions/:id/events
Accept: text/event-stream
```

SSE 提供有界且可重連的 Runtime events：

```text
session_ready
turn_start
tool_start
tool_end
context
assistant
approval_required
approval_resolved
turn_complete
turn_error
session_closed
```

最近 256 個事件另受 2 MiB session buffer 限制，可透過 `Last-Event-ID` replay。Assistant output 仍以完整 completion 為單位；token-by-token LlamaClient streaming 刻意不在這個 milestone 內。Browser 只在 local storage 保存 opaque session ID，因此 reload 或重新開啟 tab 時會重連 Runtime 並 replay presentation events，不會重新提交 conversation history；Gateway restart 後的 stale ID 會自動丟棄。

成功的 `tool_end` event 會攜帶 Runtime-derived evidence summary。UI 會區分 durable artifact（包含 generated artifact ID）與 context-only evidence，絕不從 tool success 自行推斷 durability。

### 回覆 approval

```http
POST /api/sessions/:id/approvals/:approvalId
Content-Type: application/json
```

```json
{
  "approved": false
}
```

`write_file`、`edit_file` 與 `run_command` 會等待唯一的 Browser approval。未知、重複使用、已關閉 session 或逾時的 approval 都不能授權 mutation。預設五分鐘逾時並 fail closed。

### 結束 session

```http
DELETE /api/sessions/:id
```

關閉 session 會拒絕所有 pending approvals 並中斷 event stream；project 的 durable memory 仍保留在磁碟。

## 安全邊界

- Gateway 只綁定 `127.0.0.1`。
- Host validation 阻擋 DNS rebinding 類型的 hostname。
- 拒絕 cross-site Browser request；mutation endpoint 強制使用 JSON。
- UI 使用嚴格 Content Security Policy，並以 `textContent` 顯示模型輸出，絕不渲染模型提供的 HTML。
- File containment、approval、artifact recovery 與 shell policy 仍由 `ToolRunner` 擁有。
- 系統沒有 authentication、TLS、multi-user isolation 或 OS sandbox；不可將 `8787` 暴露到 LAN。

## 刻意停止的邊界

這個 milestone 只將既有 `AgentRuntime.runTurn()` loop 接到 HTTP 與 SSE。它**沒有**把實驗中的 D0-D6 proposal／validation／transformation execution chain 接進互動 turn。未來整合需要獨立 orchestration contract 與 review boundary；Gateway 不會暗示該能力已存在。
