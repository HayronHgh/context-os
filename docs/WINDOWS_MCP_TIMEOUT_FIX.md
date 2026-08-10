# Windows llama.cpp MCP large-request timeout

[繁體中文](WINDOWS_MCP_TIMEOUT_FIX.zh-TW.md) | English

## Scope

This compatibility patch targets the pinned llama.cpp `b10295` native MCP host on Windows. It fixes requests that discover tools normally but time out when a large JSON-RPC tool-call frame is sent to the stdio MCP child.

Typical symptoms are:

- short MCP calls succeed;
- a larger `write_file` call waits until `timeout_ms` expires;
- the ContextOS MCP server never receives the timed-out frame;
- increasing `timeout_ms` changes the delay but does not fix the request.

## Root cause

The b10295 Windows `mcp_write_all` path switches the child stdin named pipe to `PIPE_NOWAIT`, then passes the entire remaining JSON-RPC frame to one `WriteFile` call. The anonymous pipe buffer used by this build is smaller than some tool-call frames. A nonblocking write cannot accept the oversized frame, so the loop retries the same oversized write until the host request times out.

The patch limits each Windows write attempt to 2048 bytes. The existing loop still owns completion, cancellation, backpressure polling, and error handling.

## Build

Prerequisites:

- the exact llama.cpp b10295 source checkout;
- MSYS2 UCRT64 CMake, Ninja, and compiler toolchain;
- Git and PowerShell.

From the ContextOS repository:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-patched-llama.ps1 `
  -LlamaSource C:\path\to\llama.cpp-b10295
```

The script:

1. verifies that the patch applies cleanly or is already applied;
2. configures a private dynamic-backend Release build;
3. builds `llama-server` without bundling a model or NVIDIA runtime;
4. reports the complete runtime directory under `build-contextos-mcp\bin`.

Do not copy only one C++ DLL between MSVC and MinGW builds. Keep the patched executable and its matching llama/ggml DLLs together in a separate runtime directory.

## CUDA deployment

The build keeps CUDA as a dynamically loaded backend. Obtain the NVIDIA runtime through its official distribution and keep those DLLs outside Git. Point `config/server.json` to the private patched runtime:

```json
{
  "llamaRoot": "../patched-mcp-server",
  "executable": "../patched-mcp-server/llama-server.exe"
}
```

Models, CUDA DLLs, generated binaries, local configuration, logs, runtime state, and the configured workspace are intentionally ignored by Git.

## Validation

Validate all of these boundaries before relying on the build:

1. `GET /health` returns `ok`.
2. `GET /tools` exposes the expected ContextOS tools.
3. A small command tool call succeeds.
4. A UTF-8 multiline `write_file` request larger than the Windows pipe buffer succeeds repeatedly.
5. The target SHA-256 equals the submitted content SHA-256.
6. A short model completion confirms that the intended acceleration backend is active.

The local reference test used a 4,243-byte HTTP request containing a 3,826-character Python file. Three consecutive calls completed in 63 ms, 62 ms, and 56 ms with exact content hashes after the patched runtime was installed.

## Rollback

Stop the stack, restore `config/server.json` so `llamaRoot` and `executable` point to the original llama.cpp bundle, then run `START.bat`. The compatibility runtime is isolated, so rollback does not require replacing original binaries.

## Distribution

The patch contains only a small source diff against llama.cpp. Retain llama.cpp's MIT license notice when distributing modified source or binaries. NVIDIA runtime libraries and model weights have separate licenses and are not part of this repository.
