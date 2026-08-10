# 完整教程

繁體中文 · [English](TUTORIAL.md)

本教程將 ContextOS 安裝在 Windows llama.cpp 發行版旁。其他目錄配置也可以，只要修改產生的設定路徑。

## 1. 準備 llama.cpp 與模型

需要：

- `llama-server.exe` 與必要 DLL
- 支援工具呼叫的 GGUF model
- 選用 multimodal projector
- 使用 CUDA build 時需要相容 NVIDIA driver

方便的目錄配置：

```text
local-ai/
├── llama-server.exe
├── required DLLs
├── models/
│   └── your-model.gguf
└── context-os/
```

這種配置下，example config 的相對 executable 與 model 目錄接近可直接使用。

## 2. Clone 與初始化

```powershell
cd C:\path\to\local-ai
git clone https://github.com/HayronHgh/context-os.git
cd context-os
.\00_setup.bat
```

Setup 會安裝 lockfile 固定的 MCP dependencies、把已提交 examples 複製成 Git 忽略的本機 config files，並以絕對 Node／ContextOS 路徑產生 Cursor-compatible `config/llama-mcp.json`。

## 3. 設定 server

編輯 `config/server.json`：

```json
{
  "llamaRoot": "..",
  "executable": "../llama-server.exe",
  "model": "../models/your-model.gguf",
  "mmproj": "../models/your-mmproj.gguf",
  "vision": false,
  "alias": "local-model",
  "host": "127.0.0.1",
  "port": 8080,
  "contextSize": 65536,
  "predict": 16384,
  "parallel": 1,
  "gpuLayers": "auto",
  "cacheTypeK": "q8_0",
  "cacheTypeV": "q8_0",
  "flashAttention": "on",
  "fitTargetMiB": 3072,
  "reasoningBudget": 4096
}
```

路徑可使用絕對路徑，或相對 ContextOS repository root。

## 4. 設定 Agent

編輯 `config/agent.json`。重要不變條件是：

```text
agent.json model == server.json alias
```

預設 profile：

```text
64K server context
12K reserved output
512-token 固定 prompt 安全餘量
800-character artifact persistence threshold
800-character stale tool compression threshold
500-character stale tool preview
每次模型呼叫最多 8K completion
4K server reasoning budget
每個 user turn 最多 20 次 tool iterations
```

必須維持以下啟動 invariant：

```text
artifactPersistenceChars <= staleToolCompressionChars <= maxToolOutputChars
```

Durability 順序錯誤時 Runtime 會拒絕啟動，不允許 evidence 在持久化前就變成可 prune。

主要 MCP integration 在獨立的 `config/mcp.json` 設定：

```json
{
  "projectRoot": "C:\\Projects\\my-app",
  "mode": "read-only",
  "maximumResourceBytes": 131072,
  "security": {
    "allowCommands": false,
    "commandTimeoutSeconds": 120
  }
}
```

這份檔案控制 capabilities，不控制 inference。Orientation／分析保持 `read-only`；只有 selected local repository 可在無 interactive approval 的情況下修改時，才使用 `trusted-local`。

## 5. 診斷與啟動

依序執行：

```text
01_start_server.bat
```

Server 會在背景執行，log 寫入 `logs/`，managed PID 放在 `runtime/`。`01_start_server.bat` 會把 `config/llama-mcp.json` 傳給 llama.cpp，由它把 ContextOS 啟動成標準 stdio child process。

看到 ready health response 後，開啟主要 Web UI，再執行 health check：

```text
http://127.0.0.1:8080
04_health_check.bat
```

Health check 會列出 llama.cpp 回報的 MCP tools。預設目標來自 `config/mcp.json.projectRoot`。

Standalone AgentRuntime CLI 仍可選用：

```text
02_start_agent.bat
```

只替 standalone CLI 指定其他 repository：

```bat
02_start_agent.bat "C:\Projects\my-app"
```

## 6. 第一個任務

先用只讀 orientation request：

```text
檢查這個 repository 的架構、測試入口與目前狀態，不要修改檔案；整理風險與下一步。
```

Runtime 會在 selected repository 建立 `.qwen-agent/`。請將自動產生狀態加入該 repository 的 `.gitignore`；只有明確想共享時才提交 `project.md`。

## 7. Approval prompts

寫入、exact edit 或 command 前，standalone CLI 會詢問：

```text
Approve edit_file: src/example.js? [y/N]
```

MCP stdio 沒有 interactive approval channel。預設 read-only mode 不公布 mutation tools；顯式 `trusted-local` 才會 auto-approve ToolRunner mutations，但 path containment、destructive-command checks、timeouts 與 evidence creation 仍然有效。

只有受控環境才使用 `--yes`：

```powershell
node .\src\index.js --project C:\Projects\my-app --yes
```

## 8. 單次模式

```powershell
node .\src\index.js --project C:\Projects\my-app --prompt "只分析失敗測試，不要修改檔案"
```

非互動模式預設拒絕 mutation，除非同時提供 `--yes`。

## 9. 記憶工作流

- `/state` 顯示 objective、constraints、failures、decisions 與 next actions。
- 編輯 `.qwen-agent/project.md` 記錄持久專案知識。
- 已解決且驗證的問題可保存成 episode。
- 大型輸出保存到 `.qwen-agent/artifacts/`。
- 超過 `artifactPersistenceChars` 的中型輸出也會持久化，即使其完整文字仍留在 active context。
- 模型以 artifact ID 呼叫 `read_artifact` 做 bounded recovery，不會提供 artifact path。
- `/new` 清除 conversation 但保留持久狀態。
- `/compact` 強制執行 structured state transfer。

## 10. Context 調校

64K profile 已在 16GB GPU 與大量 system RAM 上驗證，但不是所有硬體的通用最佳值。

啟動失敗或桌面不穩定時：

1. 提高 `fitTargetMiB`。
2. 將 `contextSize` 降到 32768。
3. 保持 `agent.json.contextWindow` 等於 server context。
4. 先測試品質，再降低 KV cache type。
5. 關閉其他 GPU-heavy application。

較大 VRAM 系統應先測 96K 或 128K，再嘗試模型最大 context。

## 11. 故障排除

### 缺少本機設定

執行 `00_setup.bat`。不要覆寫已提交 example；setup 會建立被 ignore 的 local files。

### Server offline

執行 `04_health_check.bat`，檢查 `logs/llama-server.stderr.log`。

### Port 被占用

同時修改 `server.json.port` 與 `agent.json.llamaBaseUrl`。

### Model alias 不一致

保持 `server.json.alias` 與 `agent.json.model` 相同。

### Context cancellation

確認 server/agent context 相同；模型耗盡 completion space 時增加 reserved output；減少大型 tool preview；在 session JSONL 檢查 compaction events。

### 停止 server

執行 `03_stop_server.bat`，只會停止此 checkout 記錄的 PID。

## 12. 模型下載工具

執行 `05_download_model.bat`，輸入 Hugging Face repository 與精確 GGUF filename。腳本優先使用 `hf`，不可用時改用可續傳 curl。

命令列形式：

```powershell
.\scripts\download-model.ps1 -Repo owner/repository -File model.gguf
```

可加上 `-MmprojFile projector.gguf`。

## 13. 測試

```powershell
node --test
```

35 個 invariant tests 涵蓋 durability config、小／中／大型 evidence、exact artifact recovery 與 integrity、具有 recovery gate 的 GC/exchange eviction、model serialization、episode robustness、tool-schema budgeting、deterministic pressure 行為、state-transfer validation、symlink/junction containment、memory corruption 與 destructive-command denial。只有 host 拒絕建立 file symlink 時才會跳過該項測試。
