# Windows llama.cpp MCP 大型請求逾時修補

繁體中文 | [English](WINDOWS_MCP_TIMEOUT_FIX.md)

## 適用範圍

這份相容性 patch 適用於 Windows 上固定版本 llama.cpp `b10295` 的原生 MCP host。它處理工具可以正常被發現，但較大的 JSON-RPC tool-call frame 傳送至 stdio MCP child 時逾時的問題。

常見現象：

- 短 MCP 呼叫成功；
- 較大的 `write_file` 一直等待至 `timeout_ms` 到期；
- ContextOS MCP server 從未收到該筆逾時 frame；
- 調高 `timeout_ms` 只會延後失敗，不會修復請求。

## 根本原因

b10295 的 Windows `mcp_write_all` 路徑先把 child stdin named pipe 切換成 `PIPE_NOWAIT`，再把尚未送出的完整 JSON-RPC frame 一次交給 `WriteFile`。這個 build 使用的 anonymous pipe buffer 小於部分 tool-call frame；nonblocking write 無法接收過大的 frame，因此原本迴圈會重試同一個過大寫入，直到 host request 逾時。

patch 將每次 Windows 寫入限制為 2048 bytes。既有迴圈仍負責完整送出、取消、backpressure polling 與錯誤處理。

## 建置

必要條件：

- llama.cpp b10295 的精確 source checkout；
- MSYS2 UCRT64 CMake、Ninja 與 compiler toolchain；
- Git 與 PowerShell。

在 ContextOS repository 執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-patched-llama.ps1 `
  -LlamaSource C:\path\to\llama.cpp-b10295
```

腳本會：

1. 確認 patch 可以乾淨套用，或已經套用；
2. 設定私有的 dynamic-backend Release build；
3. 建置 `llama-server`，不封裝模型或 NVIDIA runtime；
4. 回報 `build-contextos-mcp\bin` 下的完整 runtime 目錄。

不要只在 MSVC 與 MinGW build 之間交換單一 C++ DLL。修補版 executable 與相符的 llama/ggml DLL 應放在同一個獨立 runtime 目錄。

## CUDA 部署

這個 build 將 CUDA 保留為動態載入 backend。請透過 NVIDIA 官方管道取得 runtime，並將 DLL 排除於 Git。接著讓 `config/server.json` 指向私有修補 runtime：

```json
{
  "llamaRoot": "../patched-mcp-server",
  "executable": "../patched-mcp-server/llama-server.exe"
}
```

模型、CUDA DLL、產生的 binaries、本機設定、logs、runtime state 與實際 workspace 都刻意由 Git 忽略。

## 驗證

正式使用前應驗證下列邊界：

1. `GET /health` 回傳 `ok`。
2. `GET /tools` 暴露預期的 ContextOS tools。
3. 小型 command tool call 成功。
4. 大於 Windows pipe buffer 的 UTF-8 多行 `write_file` 連續成功。
5. 寫入目標的 SHA-256 等於提交內容的 SHA-256。
6. 短模型 completion 確認使用預期的加速 backend。

本機參考測試使用 4,243-byte HTTP request，其中包含 3,826-character Python 檔案。安裝修補 runtime 後，連續三次分別以 63 ms、62 ms、56 ms 完成，且內容 hash 完全一致。

## 回復原版

先停止 stack，把 `config/server.json` 的 `llamaRoot` 與 `executable` 改回原始 llama.cpp bundle，再執行 `START.bat`。相容性 runtime 採獨立部署，因此不需要覆寫或還原原始 binaries。

## 發布邊界

patch 只包含針對 llama.cpp 的小型 source diff。散布修改後 source 或 binary 時，必須保留 llama.cpp 的 MIT license notice。NVIDIA runtime libraries 與模型權重具有各自授權，不屬於本 repository。
