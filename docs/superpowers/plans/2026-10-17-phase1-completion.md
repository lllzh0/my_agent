# Phase 1 Completion Implementation Plan

状态：历史实施计划，已完成的主线能力不再作为当前待办；协作分支条目不自动视为主线缺口。当前状态与剩余工作见 [交付说明](../../workflow-agent-delivery.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Root owns shared integration and Git operations; workers must not commit or push.

**Goal:** Synchronize single-agent main, complete the five shared daily-use features and the two collaboration features already approved by the user.

**Architecture:** Preserve the frozen collaboration snapshot while preparing main in an independent checkout. Extend existing product ownership boundaries and reuse OMP model/session/task/VCS APIs. Integrate common features on main, then merge them into the collaboration branch and add team-only selection/budgets.

**Tech Stack:** Bun >=1.3.14, TypeScript/tsgo, OMP 18.10.3, existing SQLite, native VCS and local fake-provider/MCP fixtures; no new dependency.

**Spec:** docs/superpowers/specs/2026-10-17-phase1-completion.md

## Global Constraints

- `main` stays single agent; collaboration stays on `codex/team-efficiency`.
- No paid-model call, remote service trial, personal configuration change or push.
- Preserve all existing work. Only local commits needed for the requested branch integration are authorized.
- No any, ReturnType, dynamic/inline imports or provider/model-name policy branches; prompts are static Markdown.
- Product files/commands keep permission, cancellation, source provenance and record ownership boundaries.
- Optional LSP/OCR/Office/browser/structured CLI/forks/parallel writes are outside this batch.

## Task 1: Synchronize the completed single-agent base

**Files:** Frozen 113-file delta listed in artifacts/phase1-before-sync/manifest.json; integration points runtime/host.ts, runtime/session-state.ts, runtime/sessions.ts, runtime/state.ts, runtime/tools.ts, tui/commands.ts, tui/extension.ts, config/config.ts, changes/undo.ts, prompts/system.md; related tests and docs.

**Interfaces:** Produce a verified single-agent main commit with ProductSessions, Policy auto/full, SourceStore/ChangeStore, native goal/BTW and the currently implemented tools; no Collaboration dependency in product code.

- [x] Copy only relevant frozen files into the independent main checkout, remove product team wiring, keep native reusable task changes.
- [x] Add actual-wire single-agent test; retain existing behavior tests for P0/resume/goal/BTW.
- [x] Run full product tests and check, review intentional diff and credential shapes.
- [x] Save local main and collaboration base commits; merge preserving the collaboration-only delta, no remote push.

## Task 2: Model management

**Files:** New src/models/controller.ts and tui/model.ts, model tests; shared integration config/config.ts, runtime/state.ts, runtime/host.ts, tui/commands.ts.

**Interfaces:** A ProductModels owner resolves an explicit provider/id selection to Model plus exact credentials; lists permitted candidates and switches the root session with a callback to rebind reviewer/runner. Existing config.model remains valid, optional config.models supplies additional connections/custom metadata.

- [x] Test failed/unsupported/credentialless selection and endpoint routing with offline fixtures, first observe failure.
- [x] Implement explicit registry registration and session-only switching with rollback/grant reset.
- [x] Test automatic review after switching; same-provider connections must not leak credentials.
- [x] Integrate /model and update help/status/usage information, run relevant checks and independent review.

## Task 3: New session

**Files:** runtime/sessions.ts, tui/commands.ts, tui/extension.ts, cli.ts; new-session tests and host worker.

**Interfaces:** ProductSessions.newSession(signal?) returns the same committed/refresh-failed contract as resume; the host registers the native new-session UI lifecycle.

- [x] Add tests for isolated records, restoring the previous session, reset of full/grants, busy rejection and failed native/UI transitions.
- [x] Add one guarded native new-session path using the established staging/activation model; retain old records and leases.
- [x] Integrate /new, test real TUI/SDK lifecycle and shutdown.

## Task 4: Project diff and bounded review

**Files:** New src/review/diff.ts, src/review/runner.ts, src/prompts/review/*.md, tui/review.ts; integration commands/state/host; review/diff tests.

**Interfaces:** collectProductDiff(state,base?,signal?) produces a bounded immutable diff snapshot with included/excluded paths; runProductReview consumes that snapshot and explicit current model resolution, returning findings and usage without writes or team access.

- [x] Make temporary Git repositories covering staged/unstaged/untracked/deleted/binary/base/forbidden paths; assert no model call or mutation for /diff.
- [x] Reuse native VCS and OMP diff parser; precheck each path before obtaining its content and display coverage/truncation.
- [x] Use runSubprocess for a read-only review with existing product reads and a bounded request budget; protect reviewer from diff-as-instructions and report incomplete coverage.
- [x] Integrate /diff and /review; prove cancellation, usage and no write capability with a fake model.

## Task 5: MCP evidence bridge

**Files:** src/research/types.ts, research.ts and store.ts as needed; src/mcp/manager.ts; src/runtime/tools.ts; static tool descriptions; source-import/MCP tests.

**Interfaces:** Successful mcp_call returns a host-issued result ID. Import consumes the ID and an explicit content-acquisition intent, obtains only captured actual output and stores a source with provenance. No model-supplied body/address is trusted.

- [x] Add local real MCP tests for successful acquisition, failed/error/cancelled calls and forged ID; distinguish discovery from retrieved evidence.
- [x] Store captured results and import them through SourceStore with bounded text and explicit tool provenance/truncation.
- [x] Expose controlled import and retain existing mcp_call compatibility, read_source/search_source/write_report and restart behavior.
- [x] Verify credential redaction, session isolation and branch-independent source ownership.

## Task 6: Collaboration model selection

**Files:** collaboration/types.ts, roles.ts, tools.ts, controller.ts, runner.ts; config and team command/UI; role-model tests.

**Interfaces:** Shared ProductModels resolver supports role and instance selections, including decider, with exact credentials; group/member records preserve the chosen model and effort for continuations.

- [ ] Merge reviewed common changes into the collaboration branch.
- [ ] Add fake endpoints testing distinct roles, per-instance precedence, resume identity and missing credentials.
- [ ] Reuse native explicitModel/modelOverride and isolated key resolution; default inherit stays backward compatible.
- [ ] Keep the existing tool restrictions, independent-decider prompt and dispute gates; rerun collaboration regressions.

## Task 7: Shared collaboration budget and statistics

**Files:** collaboration/controller.ts, runner.ts, store.ts, types.ts, roles.ts; runtime/host.ts and tui/team.ts; group-budget tests.

**Interfaces:** Durable group accounting reserves requests synchronously before dispatch and tracks root/member/decision totals plus task elapsed time. Per-instance gates remain active. Token accounting is post-response and explicitly not a billing cap.

- [ ] Test concurrent request reservations, root/member/decision totals, budget exhaustion with partial results, cancellation and reopen.
- [ ] Add bounded shared accounting to existing group state; avoid model calls solely for summarizing statistics.
- [ ] Show readable /team and /usage group totals and current model/effort/partial state.
- [ ] Run full product checks in both branches and affected native tests, independent final review, docs/HANDOFF and local commits preserving branch separation.

## Execution record

Task ledger lives in the git-ignored SDD workspace for this plan. The approved scope above takes precedence over generic skill prompts to ask for approval again or create unrelated features. Any API refinement must be recorded with its reason and covered by behavior tests.
