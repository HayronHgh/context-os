# Tutorial

[繁體中文](TUTORIAL.zh-TW.md) · English

This guide installs ContextOS next to a Windows llama.cpp distribution. You can use another layout by editing the generated configuration paths.

## 1. Prepare llama.cpp and a model

You need:

- `llama-server.exe` and its required DLLs
- a tool-capable GGUF model
- optional multimodal projector
- current NVIDIA drivers when using a CUDA build

A convenient layout is:

```text
local-ai/
├── llama-server.exe
├── required DLLs
├── models/
│   └── your-model.gguf
└── context-os/
```

With this layout, the example config's relative executable and model directory are close to correct.

## 2. Clone and initialize

```powershell
cd C:\path\to\local-ai
git clone https://github.com/HayronHgh/context-os.git
cd context-os
.\00_setup.bat
```

Setup copies committed examples to ignored local config files.

## 3. Configure the server

Edit `config/server.json`:

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

Paths may be absolute or relative to the ContextOS repository root.

## 4. Configure the agent

Edit `config/agent.json`. The important invariant is:

```text
agent.json model == server.json alias
```

The default profile uses:

```text
64K server context
12K reserved output
512-token fixed prompt safety margin
800-character artifact persistence threshold
800-character stale tool compression threshold
500-character stale tool preview
8K maximum completion per model call
4K server reasoning budget
20 maximum tool iterations per user turn
```

Keep this startup invariant true:

```text
artifactPersistenceChars <= staleToolCompressionChars <= maxToolOutputChars
```

The runtime refuses invalid durability ordering rather than allowing evidence to become prunable before it is persistent.

## 5. Diagnose and start

Run:

```text
04_health_check.bat
01_start_server.bat
```

The server runs in the background. Logs are written to `logs/`, and the managed PID is stored under `runtime/`.

Wait for a ready health response, then launch the Web Gateway:

```text
03_start_gateway.bat
```

The browser opens at `http://127.0.0.1:8787`. The default target is the bundled `workspace/`. To select a repository immediately:

```bat
03_start_gateway.bat "C:\Projects\my-app"
```

The browser is presentation-only. Creating a session gives that session one Runtime-owned conversation, inventory, memory binding, event stream, and approval channel. To retain the terminal interface instead, run `02_start_agent.bat` with the same optional project path.

## 6. First task

Start with a read-only orientation request:

```text
Inspect this repository's architecture, test entry points, and current state. Do not edit files. Return risks and next actions.
```

The runtime creates `.qwen-agent/` inside the selected repository. Add the generated state paths to that repository's `.gitignore`; commit `project.md` only if you intentionally want to share it.

## 7. Approval prompts

Before writes, exact edits, or commands, the Browser shows an approval card containing the exact Runtime description. Approve or deny it there. The terminal UI continues to ask:

```text
Approve edit_file: src/example.js? [y/N]
```

Use `--yes` only in a controlled environment:

```powershell
node .\src\index.js --project C:\Projects\my-app --yes
```

The Browser Gateway deliberately has no auto-approve switch. Pending approvals are single-use and become Deny after five minutes or when the session closes.

## 8. One-shot mode

```powershell
node .\src\index.js --project C:\Projects\my-app --prompt "Analyze the failing tests without editing files"
```

Non-interactive mode denies mutations unless `--yes` is also supplied.

## 9. Memory workflow

- `/state` shows current objective, constraints, failures, decisions, and next actions.
- Edit `.qwen-agent/project.md` to record durable project facts.
- Solved and verified problems may be saved as episodes.
- Large outputs are stored under `.qwen-agent/artifacts/`.
- Medium outputs above `artifactPersistenceChars` are also persisted, even while their full text remains active.
- The model uses `read_artifact` with an artifact ID for bounded recovery; it never supplies an artifact path.
- `/new` resets conversation while retaining persistent state.
- `/compact` forces a structured state transfer.

## 10. Context tuning

The 64K profile was validated on a 16GB GPU with substantial system RAM. It is not a universal optimum.

If startup fails or the desktop becomes unstable:

1. Increase `fitTargetMiB`.
2. Reduce `contextSize` to 32768.
3. Keep `agent.json.contextWindow` equal to server context.
4. Reduce KV cache types only after testing quality.
5. Close other GPU-heavy applications.

For larger VRAM systems, test 96K or 128K before attempting the model's maximum context.

## 11. Troubleshooting

### Missing local config

Run `00_setup.bat`. Do not rename the example files over the committed copies; setup creates ignored local files.

### Server offline

Run `04_health_check.bat` and inspect `logs/llama-server.stderr.log`.

### Port already in use

Change both `server.json.port` and `agent.json.llamaBaseUrl`.

### Model alias mismatch

Keep `server.json.alias` and `agent.json.model` identical.

### Context cancellation

Verify server and agent context sizes match, raise reserved output if the model exhausts completion space, reduce large tool previews, and inspect compaction events in session JSONL.

### Stop the server

Run `03_stop_server.bat`. It stops only the PID recorded by this checkout.

## 12. Model download helper

Run `05_download_model.bat` and enter the Hugging Face repository and exact GGUF filename. The script uses `hf` when available and falls back to resumable curl.

Command-line form:

```powershell
.\scripts\download-model.ps1 -Repo owner/repository -File model.gguf
```

Optionally add `-MmprojFile projector.gguf`.

## 13. Tests

```powershell
node --test
```

The 35 invariant tests cover durability configuration, small/medium/large evidence, exact artifact recovery and integrity, recovery-gated GC/exchange eviction, model serialization, episode robustness, tool-schema budgeting, deterministic pressure behavior, state-transfer validation, symlink/junction containment, memory corruption, and destructive-command denial. A file-symlink test is skipped only when the host denies symlink creation.
