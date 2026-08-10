# Changelog

[繁體中文](CHANGELOG.zh-TW.md) · English

All notable changes to this project will be documented here.

## [0.2.0-dev.7] - 2026-08-10

### Bounded Host Context Bridge

- Add a loopback-only HTTP preflight that receives a copy of each browser completion request and returns an unchanged or prepared message array without mutating the browser's IndexedDB history.
- Patch the official llama.cpp b10295 `ChatService.sendMessage` through a narrow, anchor-checked overlay instead of introducing another custom chat UI or inference proxy.
- Reuse ContextManager pressure stages, tool-schema-aware accounting, and schema-validated Coding State Transfer before the browser sends `/v1/chat/completions`.
- Bound first-use oversized histories through chunked state transfers and bounded merge calls so the compaction prompt cannot itself consume the complete model window.
- Fail closed on invalid origin, request schema, state transfer, or final pressure; keep llama.cpp native context shift enabled only as a last fallback.
- Add exact request SHA-256 identity, bounded in-memory caching, loopback/CORS/request-size restrictions, and browser-history preservation telemetry.
- Add one-click Bridge -> llama.cpp -> MCP -> integrated UI startup plus exact PID identity stop handling.
- Add explicit trusted-local configuration that exposes write/edit inside one project root while command execution remains disabled.
- Add a reproducible llama.cpp b10295 Windows MCP named-pipe compatibility patch and private-runtime build guide for large JSON-RPC requests.
- Raise the tested 64K profile to a 16K reserved/output budget and add 188 automated tests, production UI type checking/build verification, and bilingual technical documentation.

## [0.2.0-dev.6] - 2026-08-10

### Standards-based MCP capability server

- Close the unmerged custom Runtime Chat Gateway PR and keep `main` on the clean dev.5 baseline; no Gateway revert or history rewrite was required.
- Add a host-independent stdio MCP server using the pinned official TypeScript SDK, with exact llama.cpp `b10295` / MCP `2024-11-05` compatibility coverage.
- Reuse the existing ToolRunner, MemoryStore, RepoMapper, ToolEvidenceManager, containment, command policy, and artifact recovery path.
- Advertise six read tools by default and require explicit `trusted-local` mode before mutation/state tools exist on the MCP surface.
- Add bounded machine-readable resources for repository map, project memory, working state, artifact index, and exact artifact recovery.
- Return Runtime-derived evidence envelopes; oversized results are externalized instead of being copied back into active model context.
- Generate separate MCP and llama.cpp host configs during setup; `01_start_server.bat` passes `--mcp-servers-config` without enabling built-in llama.cpp tools, `--agent`, or the browser MCP proxy.
- Preserve the optional standalone AgentRuntime CLI and all frozen M4/D0-D6 semantics.
- Add official-client protocol E2E, exact tool/resource, containment, mutation, corruption, evidence, and artifact recovery tests plus bilingual documentation.

## [0.2.0-dev.5] - 2026-08-10

### Zero-mutation execution preparation

- Pin the M4 `aa59f4d` experiment identity and machine-check immutable Planner, M2, M3, PAR/IPR, and telemetry inputs.
- Add read-only `RecoveryVerifier` providers for artifact integrity, repository containment/current hash, memory references, and registered rebuild mechanisms.
- Add strict `ValidatedPlan` admission checks for current inventory identity, complete decision coverage, sufficient authorization, and zero fallback.
- Emit a distinct deep-frozen `ExecutablePlan` only after every required current-source proof succeeds.
- Fail closed as `EXECUTION_PRECONDITION_FAILED` with no partial execution and machine-readable recovery errors.
- Add whole-plan `ExecutablePlan -> TransformationCandidate` preparation with a second exact inventory binding gate and no partial candidates.
- Map KEEP, PROMOTE_PROPOSAL, EVICT, and EXTERNALIZE deterministically; canonical recovery markers come only from Runtime recovery references/proofs.
- Add isolated, tool-free, bounded `transformer-v1` generation only for COMPRESS, with strict `{ content }` output and one schema-only repair.
- Compute source/candidate SHA-256 digests and candidate token estimates in Runtime; oversize candidates remain prepared for D4 to judge.
- Add Runtime-first D4 validation for exact Candidate/ExecutablePlan/Inventory binding, recomputed digests/tokens, deterministic operation invariants, canonical EXTERNALIZE markers, and COMPRESS reduction/target gates.
- Add isolated, tool-free `transform-validator-v1` semantic preservation assessment with fixed reason codes; it cannot edit candidates or override mechanical failures.
- Emit an immutable whole-plan `ValidatedTransformation`, or `TRANSFORMATION_REJECTED` with no partial approval.
- Add a model-free D5 Atomic Executor that rebinds Validation/Candidate/Plan/Inventory, source/candidate digests, and fresh recovery proofs before commit.
- Build all operations on a cloned message context, enforce tool-call structure and context generation, then commit with one reference swap; every failure leaves the active context unchanged.
- Enforce single-use validation consumption and emit immutable `ExecutionResult` / `EXECUTION_ABORTED` results with no partial execution.
- Capture D5 pre-commit token accounting with the canonical ContextManager estimator and exact tool-schema digest, without claiming actual reduction before commit.
- Add D6 generation-bound post-commit finalization, rebuilding the existing Context Inventory registry while retaining stable IDs and inactive lifecycle history.
- Measure the committed context with the same estimator/tools/overhead, preserve signed negative reduction, and report potential upper bound separately from actual reduction.
- Emit immutable `ExecutionReport` or `EXECUTION_FINALIZATION_FAILED`; finalization failure never rolls back or relabels the committed D5 execution.
- Document the complete D0-D6 dev.5 contract bilingually; artifacts and memory promotion remain absent.

## [0.2.0-dev.4] - 2026-08-10

### Bounded semantic proposal generation

- Add a deterministic globally bounded PlannerInventoryView with protected/USER/active/dependency/unresolved selection priority and implicit KEEP for hidden units.
- Add the versioned `planner-v1` prompt and an isolated, tool-free `QwenPlanner` request with fixed temperature and token budgets.
- Parse raw model output through the existing strict CompactionPlan protocol; enforce Runtime plan-ID challenge, inventory identity, and visible-only decisions.
- Allow at most one protocol/visibility/client correction; discard stale inventories immediately and stop after Validator rejection.
- Add proposal orchestration that ends at `ValidatedPlan`, with no Transformer, Executor, context mutation, artifact creation, or memory promotion.
- Record per-attempt and cumulative Planner token/latency telemetry in session audit; separate protocol, binding, visibility, client, and stale failures; and calculate proposal authorization, illegal-proposal, violation, and decision metrics.
- Add fake-client failure-mode tests, a six-unit synthetic fixture, bilingual planning documentation, and llama.cpp/Qwen smoke tooling.
- Document the dev.5 recovery-source revalidation invariant before any future execution.

## [0.2.0-dev.3] - 2026-08-09

### Runtime plan authorization

- Add a deterministic, model-free Runtime Validator that converts an untrusted `CompactionPlan` into a distinct `ValidatedPlan` and stops before execution.
- Data-drive protection, authority, and recoverability policy, including durable exact-enough recovery predicates.
- Validate `depends_on` targets and cycles before authorization, then enforce direct and transitive post-action availability.
- Keep `PROMOTE_PROPOSAL` audit-only with no memory, lifecycle, authority, context, or artifact mutation.
- Report only Runtime-derived potential reduction upper bounds; keep `actualReductionTokens` null before execution.
- Distinguish definitely insufficient authorization, potentially sufficient authorization, and rejected plans with deterministic fallback.
- Reject invalid compression targets and preserve rejected proposals with machine-readable reason codes.
- Add policy, graph, token-accounting, M2 regression, and no-side-effect tests plus bilingual validation documentation.

## [0.2.0-dev.2] - 2026-08-09

### Strict CompactionPlan protocol

- Bind every plan to a canonical SHA-256 inventory identity covering order, content digest, authority, protection, recoverability, dependencies, lifecycle, source, task, and token cost.
- Add strict `CompactionPlan` parsing with exact fields, stable unit references, five proposal actions, four importance values, and bounded reasons.
- Reject stale inventories, unknown units, duplicate decisions, unknown fields/actions, invalid IDs, Planner-owned Runtime metadata, replacement content, and authoritative savings claims.
- Define unmentioned units as implicit `KEEP`.
- Add a model-free asynchronous `FakePlanner`; no Qwen integration or plan execution exists.
- Keep `PROMOTE_PROPOSAL` data-only with no persistent-memory path.
- Add fixed inventory and valid/invalid plan fixtures plus bilingual protocol documentation.

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
