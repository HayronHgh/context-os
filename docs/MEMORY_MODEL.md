# Memory model

[繁體中文](MEMORY_MODEL.zh-TW.md) · English

ContextOS separates memory by lifetime and authority instead of storing the entire conversation as one transcript.

## Working memory

File: `.qwen-agent/state.json`

Fields include objective, current task, constraints, active files, known failures, decisions, next actions, notes, and the latest state transfer.

Working state is written through a temporary file followed by rename so an interrupted write is less likely to leave partial JSON.

## Project memory

File: `.qwen-agent/project.md`

Human-editable, durable project knowledge:

- architecture and subsystem ownership
- entry points and data flow
- coding conventions
- build, test, and lint commands
- compatibility constraints
- accepted design decisions

This is the only memory file that may be useful to commit and share with a team. Doing so is optional and may expose internal information.

## Episodic memory

Directory: `.qwen-agent/episodes/`

An episode describes a solved problem: task, symptoms, root cause, solution, files, verification, and result. `listEpisodes(N)` scans newest-first until it has the latest N **valid** episodes, so corrupted new files cannot hide older valid memory. Relevance ranking is deferred to a later version.

## Repository knowledge

File: `.qwen-agent/repo-map.json`

Generated file metadata and approximate symbols. This is a retrieval aid, not a source of truth, and should be regenerated rather than committed. Invalid JSON is treated as a cache miss and rebuilt; unlike corrupted `state.json`, it does not stop recovery.

## Tool artifacts

Directory: `.qwen-agent/artifacts/`

Exact command, test, grep, file, or other tool evidence above `artifactPersistenceChars`. Persistence is independent of prompt rendering: medium results keep their full active representation, while large results use a bounded preview.

Each text artifact has JSON metadata containing ID, creation time, tool, arguments, relative file, characters, bytes, and SHA-256. `read_artifact` retrieves at most 500 lines by ID, verifies integrity, and never accepts a model-supplied filesystem path. Recent artifact IDs are included in rebuilt system prompts and `read_working_state`, so recovery remains discoverable after a conversation reset.

As with episodes, artifact metadata listing skips corrupted entries until it collects the requested number of valid records. Exact artifact reads fail loudly on missing content or hash mismatch.

## Session events

Directory: `.qwen-agent/sessions/`

Append-only JSONL containing conversation events, tool calls, results, API usage, and compaction reports. Session logs are intended for debugging and future replay, not for prompt injection in full.

## Git policy

| Path | Default policy |
| --- | --- |
| `project.md` | Optional, review before commit |
| `state.json` | Ignore |
| `repo-map.json` | Ignore |
| `episodes/` | Ignore |
| `artifacts/` | Ignore |
| `sessions/` | Ignore |

Treat all memory files as potentially sensitive. They may contain code, filenames, internal architecture, command output, or credentials accidentally printed by tools.
