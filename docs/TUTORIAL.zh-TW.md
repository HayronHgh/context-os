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

Setup 會把已提交的 examples 複製成 Git 忽略的本機 config files。

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

## 5. 診斷與啟動

依序執行：

```text
04_health_check.bat
01_start_server.bat
```

Server 會在背景執行，log 寫入 `logs/`，managed PID 放在 `runtime/`。

看到 ready health response 後啟動 Web Gateway：

```text
03_start_gateway.bat
```

Browser 會開啟 `http://127.0.0.1:8787`。預設目標是內附 `workspace/`；直接指定其他 repository：

```bat
03_start_gateway.bat "C:\Projects\my-app"
```

Browser 只負責 presentation。建立 session 後，該 session 會擁有一份 Runtime-owned conversation、inventory、memory binding、event stream 與 approval channel。若要保留終端介面，仍可使用 `02_start_agent.bat`，並傳入同樣的 optional project path。

## 6. 第一個任務

先用只讀 orientation request：

```text
檢查這個 repository 的架構、測試入口與目前狀態，不要修改檔案；整理風險與下一步。
```

Runtime 會在 selected repository 建立 `.qwen-agent/`。請將自動產生狀態加入該 repository 的 `.gitignore`；只有明確想共享時才提交 `project.md`。

## 7. Approval prompts

寫入、exact edit 或 command 前，Browser 會顯示包含 Runtime exact description 的 approval card，請在其中選擇 Approve 或 Deny。終端 UI 仍會詢問：

```text
Approve edit_file: src/example.js? [y/N]
```

只有受控環境才使用 `--yes`：

```powershell
node .\src\index.js --project C:\Projects\my-app --yes
```

Browser Gateway 刻意不提供 auto-approve。Pending approval 是 single-use，並會在五分鐘後或 session close 時自動 Deny。

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
