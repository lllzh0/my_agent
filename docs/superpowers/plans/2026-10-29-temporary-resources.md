# Temporary Skill and MCP Resources Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded modules and independent review. Do not commit or push without a new user request.

**Goal:** 已登记 skill 和 MCP 指定工具可人工批准单次或当前运行使用，无需修改预设。

**Architecture:** TemporaryAccess 统一 grant/审批队列和失效；TemporarySkills 负责候选与内容快照；TemporaryMcp 负责候选、工具范围和临时连接；原工具与策略仍是实际执行边界。

**Tech Stack:** Bun 1.3.14、OMP 18.10.3、现有 TypeScript/SDK/TUI，无新增依赖。

**Spec:** ../specs/2026-10-29-temporary-resources-design.md

## Global Constraints

- 每个 Bun 命令和测试子进程均 --no-env-file，不读取真实环境文件，不调用外部模型。
- 只用显式登记候选；无自动安装、服务新增或包外读取许可。
- 预设/共享配置不写入临时授权，轻量模式没有临时入口。
- 当前干净工作区 eae675cc32 上实现，保留本地状态，不切换、重置、提交或推送。
- ST-A0 snapshot 2026-08-18：目标为临时资源授权，红线为原工具/策略和预设，验收为失败回归→全量/真实终端/独立审查。路由额外候选未采用。

## Task 1: Shared TemporaryAccess and existing tool compatibility

Files: create src/runtime/temporary-access.ts and test/temporary-access.test.ts; modify src/runtime/temporary-tools.ts.

Interfaces: AccessKind = tool|skill|mcp; AccessRequest {kind,key,fingerprint,label,reason,details:Record<string,unknown>}; AccessDecision=once|run|deny; AccessApprover=(request)=>Promise<AccessDecision>; class TemporaryAccess(policy) with setApprover, has(kind,key,fingerprint), grant(kind,key,fingerprint), revoke(kind?,key?), signal getter, revision getter, request(request,signal?):Promise<AccessDecision|enabled>, close().

- [x] Write failing tests: same name in different namespaces never shares a grant; changed fingerprint asks again; cancelled/revoked requests and queued late replies cannot grant run.
- [x] Implement minimal shared queue/version/store and migrate TemporaryTools to it; preserve its constructor and setApprover API, default standalone store for existing fixtures, optional shared store third argument.
- [x] Run existing 24 temporary-tools regressions and new shared tests. Record red/green, no commit.

## Task 2: Skill candidates, immutable content and scoped reads

Files: create src/skills/temporary.ts and test/temporary-skills.test.ts; add optional Skill.content support in coding-agent/extensibility/skills.ts and its focused regression tests.

Interfaces: class TemporarySkills(state, baseConfig, access); async initialize(); list(): SkillCandidate[]; effectiveSkills():Skill[]; async prepare(name,args,reason,signal?):Promise<Skill>; async load(name,args,reason,signal?):Promise<BuiltSkillPromptMessage>; finishTurn():void; revoke(name?):void; async grant(name,signal?):Promise<void>; syncReadRoots():void; close():void. SkillCandidate {name,path,description,baseDir,hash,enabled,temporary,error?}. prepare validates/clones/fingerprints content and grants package reads; effectiveSkills returns base+run and explicitly prepared single snapshot for native dispatch until finishTurn.

- [x] Test disabled registered skill needs independent approval; unknown/duplicate/invalid optional candidate does not become executable or prevent baseline startup.
- [x] Test once snapshot cannot change while approving; changed content invalidates run; native build uses frozen content and keeps existing formatting.
- [x] Test only approved package read access, no write/network/extra tool rights; finishTurn/revoke removes its roots, baseline roots survive.
- [x] Implement and run bounded tests; report exact snapshot and cancellation behavior.

## Task 3: MCP candidate and per-tool runtime boundary

Files: create src/mcp/temporary.ts, test/temporary-mcp.test.ts; modify src/mcp/manager.ts only for temporary entries and mandatory per-call scope hooks.

Interfaces: class TemporaryMcp(state, baseConfig, access); list() metadata; async discover(server,reason,signal?):Promise<unknown>; async call(server,tool,args,reason,signal?):Promise<unknown>; async revoke(server?,tool?):Promise<void>; close():Promise<void>; rebind():void; available(server):boolean. Manager API additions should be explicit and documented to root before integration; baseline call/list behavior must remain compatible.

- [x] Local HTTP tests first: once invokes one requested tool and cannot unlock another; run grants only server/tool; generic manager call cannot bypass scope.
- [x] Candidate activation still needs connection approval; no network/plan/invalid/unselected servers cannot execute; config/schema changes invalidate approval.
- [x] Test cancel/revoke closes temporary connection, keeps base connection, never retries unknown result; rebind cold-clears only session connection state, run grants stay Host-bound.
- [x] Keep mcp_call tool layer independent; no new credential/stdio capability. Run original mcp tests too.

## Task 4: Host/TUI and actual-request acceptance

Files: runtime/{host,state,tools,tool-catalog,live-resources}.ts; tui/{extension,commands,ink-shell,resources,mcp-menu,tool-access}.ts; new resource-access UI module/prompts/tests; README/docs/HANDOFF.

- [x] Register shared access and independent approveResource callback while preserving approveTool; only product control tool entry points bypass preset selection, not execution policies.
- [x] Register request_skill and request_mcp, return explicit help/list/schema, never auto grant a disabled underlying tool.
- [x] Wire manual `$candidate` approval to prepare and native frozen snapshot; effective `$` completions include run grants. Finish turn expires once; Host exit closes all, session runtime rebinds MCP and clears turn reads.
- [x] Add `/skills` and MCP scoped authorization menu with readable status, default once and read-only sanitized previews; model-origin management blocked.
- [x] Actual Host/local-model tests for preset-excluded skill/MCP, once vs run, new conversation vs cold resume, unchanged config/preset, remaining tool and policy gates.
- [x] Full product tests/check and real Mac PTY with local services; independent review, fix and reverify; update evidence and leave uncommitted.

## Execution ledger

- Task 1–3 and Host/TUI wiring completed. Implementers reached their usage limit partway through; root took over remaining fixes, integration and acceptance without changing the agreed scope.
- Initial red: MCP SDK directory cache produced 59 pass / 1 fail; real Host before wiring produced 4 fail. Root corrected SDK cache refresh and completed integration.
- Root self-review reproduced 3 failures: baseline skill hidden by a same-name candidate, eager MCP registration, schema changed while awaiting approval. Fixed with regressions.
- Independent review reproduced 4 issues: sanitized MCP schema used for manual grant fingerprints, config changed during original operation approval, turn ended during initial skill read, long reason hiding request details. Added 6 regressions including connection-time config change and immediate shared skill-read revocation; 0 pass / 6 fail before fixes. After fixes MCP 12 pass; shared access/skill/UI 35 pass.
- Independent re-review approved the fixes, independently reran 47 tests, and checked the diff. New real-terminal skill and MCP flows passed. Final product suite: 498 pass / 16 skip / 0 fail; real Mac sandbox/terminal: 17 pass / 0 fail; product and SDK checks passed; SDK skill regressions: 65 pass / 0 fail. Final evidence: ../../verification/temporary-resources-2026-10-29.md.
- Current changes remain uncommitted and unpushed.
