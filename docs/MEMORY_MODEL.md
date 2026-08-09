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

An episode describes a solved problem: task, symptoms, root cause, solution, files, verification, and result. The current MVP retrieves recent episodes; relevance ranking is planned.

## Repository knowledge

File: `.qwen-agent/repo-map.json`

Generated file metadata and approximate symbols. This is a retrieval aid, not a source of truth, and should be regenerated rather than committed.

## Tool artifacts

Directory: `.qwen-agent/artifacts/`

Full command, test, grep, or file output that was too large for prompt context. Each text artifact has JSON metadata.

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
