# OMP Stability Backports Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task. Preserve the local product gates and keep changes in the existing isolated worktree.

**Goal:** Import the user-approved upstream stability fixes into main and the collaboration branch without enabling implicit discovery or replacing the product workflow.

**Architecture:** Backport bounded source/test patches from the frozen OMP snapshot `57b56631ee009098a78d9badf91afc3a48eef32e` onto the local 18.10.3 fork. Apply clean patches directly; adapt only the affected behavior when newer upstream interfaces differ. Record upstream commit ids and regression evidence per batch.

**Tech Stack:** Bun >=1.3.14, existing TypeScript workspace and OMP SDK/TUI; no dependency or package-version upgrades.

**Spec:** User-approved upstream selection in this chat (2026-10-21); explicit resource selection, manual/auto/full authorization and single-agent main remain binding.

## Global constraints

- Main remains single-agent; collaboration stays on `codex/team-scheduler-wait`.
- Keep submission guards, `retry({skipCustomTypes:["file-undo"]})`, explicit skill lists, tool restrictions and product model bindings.
- No global discovery, provider OAuth/account pools, native agent hub, code extensions, computer/browser tools, new model providers or remote pushes.
- Reuse upstream regression tests; run them before importing the production fixes where the test API is compatible.
- Existing source savepoints: main `5ae2bb2f29`, collaboration `aa37e2fe13`.
- Worktree: `.worktrees/main-sync`, branch `codex/upstream-stability-20261021`; ordinary primary checkout stays on the collaboration branch.
- Rollback is a new revert of the affected batch; do not reset or discard either savepoint. Stop expansion if an unrelated subsystem rewrite is required.

## Task 1: Model communication and file-session durability

Files: `packages/ai/src/{dialect/deepseek.ts,utils/dsml-leak.ts,providers/openai-completions.ts,error/flags.ts}`, `packages/agent/src/prompts/dsml-tool-call-leak.md`, selected OpenCode Go catalog metadata/generator, `packages/coding-agent/src/session/session-storage.ts`, corresponding upstream tests and package changelogs.

- [x] Import/adapt upstream regression tests; demonstrate malformed DeepSeek tokens, reused parallel tool indexes, retryable gateway errors and backpressured session writes fail on the baseline.
- [x] Backport DeepSeek sequence `bc6d1c686b46 b5069878b4f9 3291a5ef3275 88ce10ae3104 4dad10b24761 98217653b24e 4e94436137f6`.
- [x] Backport `88e19a564d72`, `77e080cb836a`, `9d572fad2f5e`, `89ac5cf9666a`, `67832fc715a7`; preserve existing retry budgets.
- [x] Adapt `4670fe373108` to the existing generator/model rows without importing unrelated catalog changes. Verify the default OpenCode Go binding uses the current endpoint and explicit user URLs still override it.
- [x] Run AI provider/parser/error tests, session-storage-streaming tests and product model-host tests; save a local batch commit with upstream attribution.

## Task 2: Cancellation, recovery and failed-attempt accounting

Files: `packages/coding-agent/src/session/agent-session.ts`, `packages/ai/src/utils/{thinking-loop,leaked-thinking-stream}.ts`, upstream prompt-abort/advisor/manual-retry regressions and product goal/resource/resume tests.

- [x] Import/adapt failing regressions for interrupted setup and a newer turn, manual retry lifting suppression, and background completion respecting a human interrupt.
- [x] Adapt `8fbaf75aa288`, `908a90f1f8f7`, `dc8f2a7269a6`, `bb90cc8aa23d` while retaining admission/undo guards.
- [x] Backport accounting sequence `a9ff7cbdb3e7 db72f4bf1395 61062af4ac17` after its upstream tests fail on the baseline.
- [x] Backport `91326b08e994` to retain tool results during disconnected transition cleanup; verify product transitions remain idle-gated.
- [x] Run native lifecycle/accounting regressions plus product goal, retry, resource and resume tests; save a local batch commit.

## Task 3: TUI, MCP and bounded file reads

Files: generic TUI renderer/JSON tree/markdown helpers; native MCP errors/stdio/http and tests; native read.ts paging and tests; product MCP update integration only where required by the fixes.

- [ ] Adapt complete-card behavior from `b898e4c123dc 10ea8a3c332f a3af9fb99fc5 b5a908616c52 8d2fa941776b`, preserving sanitization and the current rendering API; add behavioral expansion/large-JSON/id regressions before the fix.
- [ ] Backport `770a32936a89` with the wide-glyph markdown table regression.
- [ ] Backport MCP sequence `231c9f81fb99 46d66ec83e8f 0bf6c7a82bca 033ab92e28b8`, preserving product environment, detached cleanup, redirects and no-automatic-replay policy; reuse cancellation/dispatch regressions.
- [ ] Adapt bounded-read behavior from `e68cb22126cb 212fbb5cb55f` without adopting unrelated file types or URI modes; test requested lines after oversized leading context and inline size limits.
- [ ] Run focused TUI/MCP/read regressions and product MCP/core tests; save a local batch commit.

## Task 4: Verify, integrate and hand off

- [ ] Run checks appropriate to all changed packages; run both full product suites after integration.
- [ ] Review the complete diff for leaked native capabilities, retry replay, lost history and changed authorization semantics. If independent review is unavailable, disclose that boundary.
- [ ] Fast-forward main to the verified integration branch and cherry-pick only new shared backport commits into the collaboration branch, resolving documentation differences without importing team code into main.
- [ ] Update HANDOFF, upstream provenance and verification records; save final local commits. No push, publication, install or real paid-model tests.
