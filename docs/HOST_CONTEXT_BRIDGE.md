# Host Context Bridge

[繁體中文](HOST_CONTEXT_BRIDGE.zh-TW.md) · English

The Host Context Bridge closes the gap between ContextOS policy and the llama.cpp browser transcript. MCP exposes capabilities, but MCP alone cannot replace the message array owned by the browser. The bridge therefore performs a bounded preflight on a copy of each outgoing request before inference starts.

## Runtime topology

```text
llama.cpp b10295 Web UI (browser owns full IndexedDB history)
        |
        | POST /v1/context/prepare with a request copy
        v
ContextOS Host Bridge on 127.0.0.1:8181
        |
        | pressure accounting and, when required, isolated state transfer
        v
prepared message array
        |
        | original Web UI POST /v1/chat/completions
        v
llama.cpp on 127.0.0.1:8080 -> Qwen

llama.cpp MCP host -> ContextOS stdio MCP -> repository/memory/evidence tools
```

The bridge is not an inference proxy and does not own durable chat history. The original browser transcript remains intact. Only the request representation sent to the model may be compacted.

## Request contract

The patched official Web UI sends:

```json
{
  "schemaVersion": 1,
  "conversationId": "browser-conversation-id",
  "messages": [],
  "tools": [],
  "maxOutputTokens": 16384
}
```

The bridge validates the schema, includes complete tool definitions in pressure accounting, and computes a SHA-256 request identity. An exact repeated request is served from an entry- and byte-bounded in-memory cache. The response is either `UNCHANGED` or `PREPARED` and includes before/after estimates and the actions taken.

## Compaction behavior

The active budget is `contextWindow - reservedOutputTokens`. With the supplied 64K/16K configuration, semantic preparation begins at 72% of the 49,152-token input budget, well before llama.cpp reaches 65,535 prompt tokens.

The existing ContextManager stages remain:

1. 55%: garbage-collect old tool output only when durable recovery exists.
2. 65%: prune old complete tool exchanges only when every result is recoverable.
3. 72%: create a schema-validated Coding State Transfer for older turns.
4. 80%: retain only the newest user work window plus the state transfer.
5. 90%: fail closed if the prepared request still cannot fit.

State transfer is isolated and tool-free. The model must return the exact state schema; one repair attempt is allowed. It cannot modify the browser transcript. If preparation fails or still exceeds the failure boundary, the Web UI does not send the unsafe completion request.

llama.cpp native context shift remains enabled as a last-resort runtime safeguard. It is not the primary semantic policy.

## Write capability

The bridge and MCP capability mode are separate concerns. To expose file mutation tools, use `trusted-local` in ignored local `config/mcp.json`. Keep command execution disabled unless it is explicitly required:

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

This advertises `write_file` and `edit_file` while preserving real-path project containment, destructive-command checks, and evidence handling. The committed default remains read-only. Point `projectRoot` at the intended repository; never use a broad home or drive root.

## Build the exact UI overlay

Use llama.cpp tag `b10295`, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-host-ui.ps1 `
  -LlamaUiSource C:\path\to\llama.cpp\tools\ui
```

The script applies a narrow, anchor-checked patch to `ChatService.sendMessage`, installs the upstream lockfile, builds the official static UI into ignored `host-ui/`, and writes `contextos-host-bridge.json`. It refuses to guess if the upstream request anchors change.

## One-click lifecycle

`START.bat` starts the bridge, llama.cpp, its stdio MCP child, and then verifies:

- bridge identity at `http://127.0.0.1:8181/health`;
- llama.cpp health;
- the MCP tool list, including write/edit when local mode is trusted;
- the integrated UI marker served by llama.cpp.

`STOP.bat` stops only the recorded llama.cpp and bridge PIDs after process identity checks. Logs are written under `logs/`; PID files are under `runtime/`.

## Security boundary

- The bridge binds to loopback only.
- Browser CORS origins are an explicit allowlist.
- Request bodies are size-bounded.
- Invalid origin, schema, state transfer, or final pressure fails closed.
- The browser keeps the authoritative full transcript.
- The bridge has no repository tool authority; repository authority stays in MCP policy.
- The static overlay is pinned to and checked against llama.cpp b10295.

This is a host adapter around the existing ContextManager, not a change to the frozen M2/M3 planner authorization or D0-D6 atomic execution contracts.
