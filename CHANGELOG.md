# Changelog

[繁體中文](CHANGELOG.zh-TW.md) · English

All notable changes to this project will be documented here.

## [0.2.0-dev.1] - 2026-08-09

### Adaptive context planning foundation

- Freeze the resolved v0.1.2 merge commit as an annotated benchmark control with exact llama.cpp, GGUF, prompt, config, chat-template, and host fingerprints.
- Add RFC-001 in English and Traditional Chinese.
- Add validated Context Units with stable session/sequence identity, authority, recoverability, protected reasons, typed dependencies, token cost, and lifecycle.
- Add a bounded observational Context Inventory and `/inventory` command without changing deterministic context policy.
- Keep all Context Unit metadata behind the model serialization boundary.
- Add the first oracle-backed benchmark fixture and M0/M1 tests.

## [0.1.2] - 2026-08-09

### Durability and core invariant freeze

- Persist medium and large tool evidence independently of prompt rendering
- Add machine-checkable internal recovery metadata and a model serialization boundary
- Gate 55% stale-output compression and 65% exchange eviction on artifact recoverability
- Add the twelfth runtime tool, `read_artifact`, with bounded ID-only retrieval
- Record artifact characters, bytes, SHA-256, tool, arguments, and creation metadata
- Preserve artifact recovery references through pruning, State Transfer, reset, and working-state reads
- Define `listEpisodes(N)` as the latest N valid episodes
- Add artifact/compression/eviction/blocked-eviction observability counters
- Reject invalid durability threshold ordering at startup
- Expand the core invariant suite from 22 to 35 tests
- Freeze the deterministic Phase 1/2 baseline; reserve adaptive semantic planning for v0.2.0

## [0.1.1] - 2026-08-09

### Correctness hardening

- Count complete tool schemas, `tool_choice`, and fixed prompt overhead in context utilization
- Separate stale-output compression, complete tool-exchange pruning, semantic compaction, and hard transfer
- Validate Coding State Transfer fields and types, retry once, then fail without replacing history
- Mark State Transfer as derived state and require repository/tool verification for mutable facts
- Enforce real-path containment against symlink and Windows junction escapes for file tools
- Skip malformed episodes without hiding valid memory; keep corrupted working state fail-loud
- Expand the invariant suite from 5 to 22 tests
- Reconcile the documented current 64K validation profile with the 32K troubleshooting fallback

## [0.1.0] - 2026-08-09

### Added

- Persistent working, project, episodic, and repository memory
- Eleven runtime-managed coding tools
- Tool artifact externalization
- Five-stage context budget and Coding State Transfer
- OpenAI-compatible local-model client
- Windows setup, start, stop, diagnostics, and download scripts
- Project-root file containment and mutation approvals
- Initial test suite
- English and Traditional Chinese documentation

### Known limitations

- Experimental MVP
- Windows-first
- No strong shell sandbox
- Approximate token counting and regex repository mapping
