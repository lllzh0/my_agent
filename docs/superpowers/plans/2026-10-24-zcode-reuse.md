# ZCode Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add selective external skill import and opt-in local model request traces with request comparison.
**Architecture:** Product-owned discovery/import integrates with LiveResources. A bounded trace store observes provider calls and supplies terminal inspection/diff without making additional requests.
**Tech Stack:** Existing Bun, TypeScript, OMP SDK/TUI and diff; no new dependencies.
**Spec:** `docs/superpowers/specs/2026-10-24-zcode-reuse.md` (approved behavior in chat).

## Global Constraints

- Work in the existing requested product checkout; preserve current changes, no commits/branches/push/install/release.
- Trace defaults off, process-local switch; no credentials/headers, bounded storage, no diagnostic failure altering model execution.
- Skills remain explicit resources. No automatic activation during discovery, no overwrite of existing skills.
- Bun tests of observable behavior; no module mocks or source-string tests; comply with AGENTS.md.

## Task 1: External skill import

Files: new `src/skills/external.ts`, `src/tui/skill-import.ts`, `test/external-skills.test.ts`; modify `src/tui/resources.ts`, narrowly extend `src/runtime/live-resources.ts` if serialization is needed. Root is `packages/workflow-agent/`.

- [x] Add failing discovery/import tests using temporary HOME and workspace, including unrelated unselected malformed skills, duplicate names, same-target conflicts, copy with support files, link, cancellation and unsafe links.
- [x] Implement `discoverExternalSkills` and `importExternalSkills` with explicit selected candidates and detailed results. Use existing frontmatter parsing and centralized filesystem/path utilities where appropriate.
- [x] Connect source selection, per-skill toggles, preview, copy/link and apply to the resources menu. `importExternalSkills` must coordinate staging and `LiveResources.apply`, preserve original resources on errors and reject busy changes before side effects.
- [x] Run `bun test packages/workflow-agent/test/external-skills.test.ts packages/workflow-agent/test/resources.test.ts` and package checks; review the task.

## Task 2: Request traces and inspection

Files: new `src/diagnostics/model-trace.ts`, `src/tui/trace.ts`, `test/model-trace.test.ts`; modify product `runtime/host.ts`, `runtime/state.ts`, `tui/commands.ts`, `tui/extension.ts`, and SDK observation seam only if needed.

- [x] Add failing integration test through the real product host and localhost model: run `/trace on`, ask twice with a resource change, run `/trace compare`, verify exact captured provider fields and no extra requests; default-off/turn-off preserve absence of new logs.
- [x] Implement bounded serialization/store with IDs, per-session files, redaction, explicit missing/truncated content, inspect and diff.
- [x] Observe call lifetime and provider payload/response callbacks without replacing original payload or consuming stream twice; preserve abort/errors and isolate side-call correlation.
- [x] Wire commands/help/menu and lifecycle. Test tool-result linkage, model errors/cancellation, session changes, retention and write failure.
- [x] Run trace/integration tests and package checks; review the task.

## Task 3: Integration, provenance and delivery

- [x] Document user commands, exact captured sources, storage limits, import target, copy/link effects, known boundaries and ZCode provenance/license.
- [x] Run full product suite and focused upstream tests for any changed SDK seam; run package lint/format/type checks and a real terminal smoke against demo/local data.
- [x] Obtain independent read-only trace findings; resolve them and perform coordinator self-review when the review agent becomes unavailable. Full independent review remains unverified (usage limit).
- [x] Record final evidence and remaining real-model/platform/human acceptance boundaries. Deliver changed source without Git commit or installation.

## Progress and rulings

- Baseline: product check exit 0; resources/stream-diagnostics/message-metrics/commands 37 pass, 0 fail.
- Ruling: use current clean checkout (HEAD fb55125fba) as requested; no separate branch/worktree because delivery is requested in this workspace and Git management is not part of the task.
- Ruling: one implementation subagent owns skill import; coordinator owns independent trace code, with disjoint file ownership; final review includes integration.
- Interfaces: skill import only integrates via `resources.ts`/`LiveResources`; trace owns commands/state/host/extension. No shared file edits between implementers.

## Final evidence

- Product suite: 301 pass, 7 platform-gated skips, 0 fail. Native macOS sandbox rerun: 7 pass, 0 fail.
- SDK regressions: 157 pass, 0 fail across four relevant files; SDK lint/format clean.
- Final media omission fix: 10 trace/store tests pass; product lint/format/type check passes.
- Real PTY demo completed selective import, activation in the next request, comparison, off, and exit.
- Independent reviewer reported token masking, pretty-JSON sizing and capture-stage findings before a usage-limit interruption. Coordinator reproduced and fixed those, plus integration/selection/link/media regressions. No final independent-review pass is claimed.
- User guide, provenance/license and exact evidence: `docs/workflow-agent-zcode-reuse.md`, `docs/workflow-agent-zcode-reuse-verification.md`.
- No commits, installation or release. Human acceptance and real-service/cross-platform checks remain separate.
