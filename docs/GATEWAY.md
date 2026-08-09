# Runtime Chat Gateway

[繁體中文](GATEWAY.zh-TW.md) · English

## Purpose

The Runtime Chat Gateway turns the existing CLI runtime into a browser-usable local agent without making the browser the owner of conversation state.

```text
Browser :8787
    ↓ HTTP + SSE
RuntimeSession
    ↓ one owned AgentRuntime
tools · evidence · memory · deterministic context management
    ↓ shared LlamaClient
llama-server :8080
    ↓
Qwen
```

llama.cpp remains the inference backend. The Gateway does not proxy llama.cpp's built-in UI and does not enable llama.cpp built-in filesystem tools.

## Start

Start the model first:

```text
01_start_server.bat
```

Then launch the browser runtime:

```bat
03_start_gateway.bat "C:\path\to\your\repository"
```

This starts a loopback-only HTTP server at `http://127.0.0.1:8787` and opens the browser. Stop it with `06_stop_gateway.bat`.

The equivalent terminal command is:

```powershell
npm run gateway -- --project "C:\path\to\your\repository"
```

## Source-of-truth boundary

Each `POST /api/sessions` creates exactly one `RuntimeSession`, one `AgentRuntime`, one message history, one Context Inventory registry, and one project-local `MemoryStore`. The `LlamaClient` and llama-server process are shared. The Gateway permits only one active session per canonical project root because the file-based MemoryStore has no cross-session transaction lock.

The browser stores only presentation state. It never resubmits a `messages[]` transcript. A turn supplies only the next user message:

```json
{
  "content": "Inspect src/agent-runtime.js and cite file evidence."
}
```

This prevents browser history from bypassing Runtime pruning, durable evidence, recovery references, or context generation.

## API

### Create a session

```http
POST /api/sessions
Content-Type: application/json
```

```json
{
  "projectRoot": "C:\\path\\to\\repository"
}
```

The directory must already exist. Session creation initializes `.qwen-agent/` through the existing `MemoryStore` and checks llama-server health.

### Run one turn

```http
POST /api/sessions/:id/turn
Content-Type: application/json
```

Only one turn may run per session. A concurrent request fails with `409 SESSION_BUSY`.

### Observe events

```http
GET /api/sessions/:id/events
Accept: text/event-stream
```

The SSE stream exposes bounded, reconnectable Runtime events:

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

The latest 256 events, bounded again by a 2 MiB session buffer, are replayable with `Last-Event-ID`. Assistant output remains completion-level; token-by-token LlamaClient streaming is intentionally outside this milestone. The Browser stores only an opaque session ID in local storage, so a reload or reopened tab reconnects to the Runtime and replays presentation events without resubmitting conversation history. A stale ID is discarded automatically after a Gateway restart.

Successful `tool_end` events carry a Runtime-derived evidence summary. The UI distinguishes a durable artifact (including its generated artifact ID) from context-only evidence; it never infers durability from tool success.

### Resolve approval

```http
POST /api/sessions/:id/approvals/:approvalId
Content-Type: application/json
```

```json
{
  "approved": false
}
```

`write_file`, `edit_file`, and `run_command` wait on a unique browser approval. Unknown, reused, closed-session, and timed-out approvals cannot authorize a mutation. The default timeout is five minutes and fails closed.

### End a session

```http
DELETE /api/sessions/:id
```

Closing a session denies pending approvals and disconnects its event stream. Durable project memory remains on disk.

## Security boundary

- The Gateway binds only to `127.0.0.1`.
- Host validation blocks DNS-rebinding-style hostnames.
- Cross-site browser requests are rejected; mutation endpoints require JSON.
- The UI has a restrictive Content Security Policy and renders model output with `textContent`, never model-provided HTML.
- File containment, approvals, artifact recovery, and shell policy remain owned by `ToolRunner`.
- There is no authentication, TLS, multi-user isolation, or OS sandbox. Do not expose port `8787` to a LAN.

## Deliberate stop boundary

This milestone adapts the existing `AgentRuntime.runTurn()` loop to HTTP and SSE. It does **not** wire the experimental D0-D6 proposal/validation/transformation execution chain into interactive turns. That future integration requires its own orchestration contract and review boundary; the Gateway does not claim it implicitly.
