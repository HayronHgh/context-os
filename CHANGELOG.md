# Changelog

[繁體中文](CHANGELOG.zh-TW.md) · English

All notable changes to this project will be documented here.

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
