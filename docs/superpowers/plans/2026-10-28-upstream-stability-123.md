# OMP stability backports 1–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve existing text-file conventions, retain successful compaction when an optional short summary fails, and recover compaction queues without loss or duplication.

**Architecture:** Adapt three bounded upstream fix series to the current SDK and My Agent wrappers. The product approval preview, stale-file check and undo journal must agree with bytes written. Queue recovery tracks the exact messages owned by a flush, rather than clearing the whole session queue.

**Tech Stack:** Bun 1.3.14, TypeScript, existing Bun tests, OMP 18.10.3 fork.

**Spec:** User approval on 2026-10-28: implement recommended groups 1, 2 and 3, test, then commit. Fixed upstream source is `/tmp/omp-upstream-audit-20261028` at `413d278a87a69b453efabf8d1fedb9940385e8c6`.

## Global Constraints

- Keep Bun 1.3.14, dependency versions, launch-only preset isolation, approvals and sandbox enforcement.
- Do not implement recommended groups 4–6, GUI work, upstream background-wake redesign, or a full upstream upgrade.
- Use `bun --no-env-file`; do not read or print `.env.local`, call paid models, or write real user config/history.
- Work in the existing clean main checkout as authorized by the ongoing workflow. No reset, restore, clean, broad stash, force push or history rewrite.
- Commit intentional changes only after covering tests pass. Do not push.
- No `any`, `ReturnType<>`, dynamic imports, new dependencies or inline production prompts.
- Upstream clone is read-only source material; adapt only the approved paths. Preserve local submission guards, `$` skill routing, approval checks and manual-stop behavior.
- Rollback: revert the resulting ordinary commits; do not discard workspace changes.

### Task 1: File convention and cancellation safety

**Files:**
- Modify `packages/coding-agent/src/tools/write.ts`, `packages/coding-agent/src/edit/normalize.ts` (or a narrow shared helper alongside it).
- Modify `packages/workflow-agent/src/runtime/tools.ts`, `packages/workflow-agent/src/changes/journal.ts`, `packages/workflow-agent/src/changes/store.ts`.
- Create `packages/coding-agent/test/write-line-endings.test.ts`; extend `packages/workflow-agent/test/file-approval.test.ts` and journal tests when needed.
- Update the coding-agent Unreleased changelog for this behavior.

**Interfaces:**
- Existing `WriteTool.execute`, product `productTools`, and `ChangeJournal.inspect/capture/restore` retain their signatures.
- Reuse shared LF/CRLF/BOM helpers for native writes and product previews. `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` preserves BOM in journal strings.
- An ACP editor receives its input unchanged and owns its save convention. My Agent is itself a bridge and must prepare the approved content before calling the native tool.

**Source:** `0ffd42c7146a f77456fe1d75 28cc26edb5b4 f4ab1de8ca2c f4a34dea8182 9f93dddf2f87`. Read final `write.ts` and `write-line-endings.test.ts` at `9f93dddf2f87` using `git -C /tmp/omp-upstream-audit-20261028 show`.

- [x] Copy/adapt upstream regression tests first. Run non-cancellation cases red: `bun --no-env-file test packages/coding-agent/test/write-line-endings.test.ts -t 'CRLF|BOM'`. Avoid waiting on the scan-cancellation test against an implementation that has no scan yet.
- [x] Add product tests that write `"\uFEFFfirst\r\nsecond\r\n"`, request `"updated\nsecond\n"`, inspect raw bytes via `fs.readFile(target, "utf8")`, check approval only changes `first` to `updated`, and restore to the exact original string. Add a BOM-only external change during approval and assert rejection with no overwrite.
- [x] Implement the final upstream scan/convention/cancellation behavior with shared normalization. Respect explicit CR characters, empty writes, binary/new/LF files, long first lines, formatting and batch notes. Check cancellation after any caught scan abort and before disk writing.
- [x] Prepare product content before approval (content hash, preview and native call use the same bytes); journal decoding must retain BOM for version checks and undo. Enforce the existing 1 MB post-normalization write limit.
- [x] Bind stored snapshots as bytes: the Bun 1.3.14 string binding loses a leading BOM before persistence (`hex(content)` confirms this); TEXT reads are verified to preserve BOM. Preserve the existing TEXT schema and queries with `CAST(? AS TEXT)` for byte-bound values; verify close/reopen then exact restore.
- [x] Run all new file tests plus existing product file-approval and journal tests; run product check and relevant package lint/format/type checks. Save command/count evidence to the task report, review, then commit this task only.

### Task 2: Optional short-summary isolation

**Files:**
- Modify `packages/agent/src/compaction/compaction.ts`.
- Create `packages/agent/test/compaction-short-summary.test.ts` from upstream `649b095b9514`.
- Update agent Unreleased changelog.

**Interfaces:**
- `compact` retains the full summary and returns `shortSummary: undefined` when the optional short request errors or is empty.
- Cancellation remains an `AbortError`; successful short summaries and remote full compaction retain their existing behavior.

**Source:** `649b095b95141bfda614f1bad082ad843090d32c` (source patch also `/tmp/omp-short-summary.patch`).

- [x] Adapt upstream tests first; use injected completion/HTTP fixtures only. Required cases: short success, error response, empty response, aborted response, caller cancellation, optional remote HTTP failure and remote cancellation.
- [x] Run `bun --no-env-file test packages/agent/test/compaction-short-summary.test.ts` red. The full-success/short-error fixture must reject before the fix.
- [x] Adapt only the short-summary outcome path: `{kind:"text",text}`, `{kind:"failed",error}`, `{kind:"aborted"}`. Warn on optional failures, omit absent short text, and propagate cancellation without discarding a full summary on ordinary failure.
- [x] Run the new test and existing compaction tests, plus agent check. Report evidence, review, then commit this task only.

### Task 3: Queue recovery without loss or replay

**Files:**
- Modify `packages/coding-agent/src/modes/utils/ui-helpers.ts`, `packages/coding-agent/src/modes/skill-command.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/agent-session-types.ts`.
- Adapt upstream queue tests: `compaction-flush-failure-keeps-queue.test.ts`, `compaction-flush-loop.test.ts`, `input-controller-compaction-image.test.ts`, `input-controller-skill-queue.test.ts`, `issue-825-repro.test.ts`; add focused coverage where required by local behavior.
- Update coding-agent Unreleased changelog.

**Interfaces:**
- Add optional `PromptOptions.onPromptQueued?: (queued: readonly AgentMessage[]) => void` and propagate it through steer/follow-up/custom/skill paths as the final upstream series does.
- `AgentSession.dropQueuedMessages(messages: Iterable<AgentMessage>)` removes exact object identities belonging to this flush, preserving foreign messages.
- First admitted input is not replayed on a later failure. A first skill that has not been admitted is not lost. Preserve images and submission ownership.

**Source:** `27ff9369b700 0e884e58320b 470fcb26c281 318144430141` in order; use final relevant code/tests at `318144430141`, not the intermediate interval-marker design.

- [x] Read the four commits and current local queue delivery methods. Copy/adapt regression tests first; retain actual session queue side effects in tests.
- [x] Run targeted tests red. Cover unrelated pending messages before/during flush, admitted first prompt, rejection before admission, late admission, skill rejection/drop, and image companions.
- [x] Implement exact queue ownership callbacks and surgical removal; restore only unadmitted/undelivered input. Do not call broad `clearQueue()` on the failure path.
- [x] Run the new/changed queue tests and existing skill/session/submission tests, plus coding-agent check. Report evidence, review, then commit this task only.

### Task 4: Integrated validation and delivery record

**Files:** `HANDOFF.md`, `docs/workflow-agent-upstream-backports.md`, `docs/verification/upstream-stability-2026-10-28.md`, this plan.

- [x] Run product full suite and check; run agent/coding-agent checks and the affected native test groups on the final code. Use local fixtures, no paid API calls. Existing Mac sandbox and Ink acceptance can be repeated if the integration changes those boundaries; record Windows actual runtime as untested.
- [x] Perform one broad independent review of the complete change; resolve actionable findings with covering tests.
- [x] Record red/green evidence, final commands/counts, exact upstream attribution and untested boundaries; mark completed steps.
- [x] Inspect status/diff/recent log, ensure no secrets or generated outputs, commit documentation and any reviewed integrated fixes. Verify final status and report commit IDs. No push.

**Execution record:** Tasks 1–3 and independent reviews complete. Final product 359 pass / 16 skip / 0 fail; real Mac sandbox/Ink 10 pass; final code review Ready: Yes with one non-blocking formatter regression gap. Code commits: `70d95e7c5d 8b47294e21 96af7dbb60 d9e187fa60`. Final evidence and limits: `docs/verification/upstream-stability-2026-10-28.md`. Documentation saved in the following local commit; no push.
