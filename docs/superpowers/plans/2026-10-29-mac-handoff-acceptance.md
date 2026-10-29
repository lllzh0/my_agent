# macOS 预设管理与交接验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the test implementation and independent review. Controller owns isolated clean preparation and integrated verification. Do not commit or push: the current request authorizes Mac completion, not Git publication.

**Goal:** Close the macOS gaps for existing preset management/handoff and the updated source preparation command.

**Architecture:** Keep the shared product implementation. Canonicalize test-owned temporary paths at creation, preserving explicit link/escape cases. Drive the actual launcher and Ink TUI through the existing PTY helper with local model/MCP fixtures; collect disk, request, process and terminal evidence. Validate preparation separately in a clean Git archive and empty Bun cache.

**Tech Stack:** macOS arm64, Bun 1.3.14, existing Bun tests/VirtualTerminal, OMP 18.10.3.

**Spec:** `HANDOFF.md` (Mac preparation and preset handoff gaps), `docs/verification/batch3-terminal-handoff-2026-10-29.md`, user's request “先补齐mac这边的工作吧”. Baseline `58cce6f8e9`.

## Global Constraints

- Keep Bun 1.3.14, dependencies/lockfile, shared Win/Mac logic, approval and sandbox enforcement, single-agent main.
- No GUI, Windows system ACL operations, unrelated refactors, real credentials, paid model/search calls or real user config/history changes.
- Use `bun --no-env-file`; model/MCP traffic is restricted to controlled localhost fixtures.
- Work in the existing clean main checkout. Do not create a branch/worktree, discard work, commit or push.
- Prefer test/fixture changes; a production change needs an observed runtime failure and the smallest covering regression.
- Preserve real alias/escape coverage. Do not make tests pass by weakening path checks, removing assertions or globally overriding the temporary directory.
- No `any`, `ReturnType<>`, dynamic imports, new dependencies or inline production prompts.
- Patch budget: 9 files / 1400 changed lines, including docs. Report a justified scope adjustment if actual evidence requires more.
- Rollback: remove only this task's uncommitted edits; keep prior work and evidence. Never reset/restore/clean/stash.
- A0 receipt: code-quality-workflow, ST-A0, snapshot2026-08-18; goal/red lines/acceptance restated in commentary. Irrelevant GUI catalog suggestion not adopted.

### Task 1: Default-path regression and actual Mac terminal acceptance

**Files:**
- Modify `packages/workflow-agent/test/preset-management.test.ts`, `packages/workflow-agent/test/preset-handoff.test.ts`.
- Extend `packages/workflow-agent/test/ink-acceptance.test.ts`, or create a focused sibling test with a narrow shared terminal helper under `test/` if reuse requires it. Keep existing acceptance behavior.
- Only if a real runtime failure is found: minimally fix the owning product file with a failing regression first; report the cause before expanding scope.

**Interfaces:** Existing `openTerminal`/`VirtualTerminal` launch real Bun PTYs. `fixture()` provides a local scripted OpenAI-compatible endpoint and isolated home/workspace; preset definitions remain version1. Do not add test hooks to production.

- [x] Reproduce the existing default-environment red command: `bun --no-env-file test packages/workflow-agent/test/presets.test.ts packages/workflow-agent/test/preset-management.test.ts packages/workflow-agent/test/preset-handoff.test.ts` (30pass/7fail). `/tmp/my-agent-latest-review-20261029.log` is initial evidence. Canonical temporary-directory control produced37pass/0fail; it is diagnostic only.
- [x] Change fixture creation to `await fs.realpath(await fs.mkdtemp(...))` at the two inconsistent sources. Keep the deliberate `home-alias` test alias intact. Run the same command without TMPDIR override; expect37pass/0fail.
- [x] Add actual-terminal tests using existing production entrypoints: create/edit/cancel/save a preset, default binding affects next launch; A→B→resume A within one terminal with distinguishable instructions/tools/history; preserve model key/effort/plan, and ensure temporary full grants are not persisted. Inspect local requests and session/journal files, not just response wording.
- [x] Exercise real terminal cancellation during preparation, target preparation/validation failure preserving the source and pending target records, and a controlled local HTTP MCP close on handoff where practical. Use controlled file locks/malformed selected references rather than production test hooks. Label the exact failure stage verified; unit fault injection is not real PTY evidence.
- [x] Run focused new tests, the three default-path files, affected existing terminal/session/preset groups, and product check. Record commands/counts/logs and any genuine remaining boundary. No commit. Independent review follows.

### Task 2: Clean macOS preparation, full regression and evidence

**Files:** `HANDOFF.md`, `docs/workflow-agent-delivery.md`, `docs/workflow-agent-presets.md`, new `docs/verification/mac-preset-handoff-2026-10-29.md`, this plan. Update only necessary current-status links; preserve Windows failure evidence.

- [x] Create a clean tracked-source Git archive at baseline58cce6f8e9 in a new `/private/tmp` directory, no existing node_modules/native binary/user state, and an empty task-specific Bun cache. Run the actual `agent:prepare` with final official-registry/concurrency8 parameters; do not alter scripts/lockfile or use installation scripts.
- [x] In that copy use isolated home/workspace for setup, doctor, demo and new-process resume; run product check. No real model requests. Record exact platform/native version, exits, elapsed time and preparation boundaries.
- [x] After reviewed test edits stabilize, run the full product suite and check with normal temporary-directory settings. Re-run real Mac sandbox/Ink cases with `MY_AGENT_SANDBOX_TEST=1` on a permitted host; retain Windows actual/system-isolation gaps.
- [x] Review the complete working diff independently. Record source/fixture changes, red/green evidence, real PTY acceptance, clean-preparation evidence and untested limits. Mark completed checks only after observing success. Leave changes uncommitted and report status.

**Execution record (2026-10-29):** Mac default full suite396pass/16skip/0fail,2219assertions/54files; enabledsandbox+Ink14pass/158assertions; productcheck passed. Cleanarchive/emptycacheprepare27.81s, native18.10.3, isolatedsetup/doctor/demo/coldresume/check passed. Onlytestfixtures/PTYevidence/docs changed. Firstfull failure and semanticreadiness fix retained in verification record. Finalwhole review and wordingrereview Ready:Yes. Changes remainuncommitted/unpushed.
