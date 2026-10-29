# Temporary Tools Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded modules and reviews; steps use checkbox syntax. Do not commit without a new explicit user request.

**Goal:** 通过人工批准单次或当前运行期授权，让预设关闭的产品工具可以临时使用。

**Architecture:** `TemporaryTools` 在 Host 内存中保留工具授权，以原产品工具回调执行已批准请求。模型使用 `request_tool` 发现并提交具体申请；现有资源工具同步和执行守卫都识别运行期授权，原策略层继续检查每笔操作。

**Tech Stack:** Bun 1.3.14、现有 TypeScript SDK、现有 TUI 和测试夹具，无新增依赖。

**Spec:** ../specs/2026-10-29-temporary-tools-design.md

## Global Constraints

- 不读取真实 `.env.local`；Bun 命令统一 `bun --no-env-file`，测试使用本地假密钥。
- 不提交、不推送、不改全局配置；保留原八项 Mac 改动。
- 不增加依赖，不整体升级 omp，不开启目录/联网/计划模式例外。
- 当前工作区包含用户持续工作，按明确实现授权在现有工作区推进；不切换或重置当前 checkout。
- 同一授权只存内存；模型不拥有批准结果、期限或管理命令。

### Task 1: 工具能力控制器与边界测试

**Files:** Create `packages/workflow-agent/src/runtime/temporary-tools.ts`, `packages/workflow-agent/test/temporary-tools.test.ts`.

**Interfaces:** `ToolAccessRequest { tool, reason, arguments }`, `ToolAccessDecision = once | run | deny`; `TemporaryTools(state, tools)` owns `setApprover`, `list`, `allows(name,input?)`, `isEnabled(name)`, `grant`, `revoke`, `clearJobs`, `close`, `execute(id,input,signal,update,ctx)`.

- [x] 先使用真实文件工具写出禁用 write 经 once 申请后仅创建第一个文件、下一次仍需申请的失败测试；`expect(await Bun.file(target).text()).toBe("approved")`。
- [x] 测试 run 只解锁对应工具、拒绝无副作用；传入 write 参数缺少 content 时在审批前失败。
- [x] 测试等待审批期间取消、撤销、策略模式变化、参数被修改均不能执行未经批准的内容。
- [x] 最小实现上述接口，复用 `validateToolArguments` 和 `untilAborted`。保留原工具策略调用，拒绝 goal/未知工具及未选 MCP。
- [x] 测试实际文件越界、计划模式、禁网仍拒绝；一次性 bash 后后台 job 仅凭所属 ID 可查看和停止。
- [x] 运行 `bun --no-env-file test packages/workflow-agent/test/temporary-tools.test.ts` 并记录红绿结果。

### Task 2: 审批与人工管理 UI

**Files:** Create `packages/workflow-agent/src/tui/tool-access.ts`, `packages/workflow-agent/test/tool-access-ui.test.ts`; Modify `src/tui/operation-preview.ts` only if needed to reuse selection/preview loop.

**Interfaces:** `chooseToolAccess(request, select, inspect)` returns once/run/deny; `toolsFromCommand(state,ctx,args,ensureIdle)` manages `/tools [list|allow <name>|revoke <name>|clear]` using `TemporaryTools`.

- [x] 先用受控选择器证明打开详情然后取消不会授权；选择运行期授权才返回 run，关闭返回 deny。
- [x] 使用现有脱敏、有界预览展示工具、理由、真实参数、授权期限和原策略仍会检查的说明。
- [x] 使用自然语言列表显示三种工具状态。无 UI 的管理写命令拒绝；人工菜单启用只提供运行期授权。
- [x] 测试撤销后 `allows("write")` 为 false；确认空闲检查和取消检查在选择完成后仍然执行。
- [x] 运行 `bun --no-env-file test packages/workflow-agent/test/tool-access-ui.test.ts`。

### Task 3: Host 集成、真实请求和交付

**Files:** Modify `src/runtime/{state,tools,host,live-resources,tool-catalog}.ts`, `src/tui/{extension,commands,resources}.ts`, `src/prompts/system.md`; Create `src/prompts/tool-request-tool.md`, integration tests and verification record.

- [x] 先让真实 Host 的本地模型提交 `request_tool`，证明禁用 write 能申请后创建文件；在未实现时失败。
- [x] 注册控制入口但保持预设能力表原有语义；默认不对模型公开被关闭的工具参数，只在主动发现时返回。
- [x] 两处执行守卫和模型请求前同步统一使用有效工具权限；Host 的普通关闭及会话运行时替换清除正确范围。
- [x] 在 session_start 绑定独立人工能力审批；无 UI 默认 deny，HostOptions 提供专用回调用于 SDK 宿主，原操作 approve 不隐式扩大能力。
- [x] `/tools` 接入新菜单并拦截模型来源管理命令；资源页面提供明确入口。
- [x] 覆盖请求中工具清单、预设文件未改变、运行期新对话保留/冷恢复清空；对话计划模式和 MCP 各自策略不变。
- [x] 运行产品完整测试和 `bun --no-env-file run --filter @my-agent/workflow-agent check`；真实 Mac 终端使用本地服务验收。
- [x] 独立审查完整本次差异，修复发现并复验；更新使用文档和验证记录，交付未提交状态。

## 执行记录

- 2026-10-29：用户已批准设计和实现。A0 路由 `code-quality-workflow`，snapshot `2026-08-18`，加载 `ST-A0`；无设计候选，验收不使用真实凭据。
- 任务边界检查：Task 1 产出控制器接口，Task 2 消费它但只拥有 UI 文件，Task 3 负责共享集成文件；实现者不得并发修改共享文件。单次调用经原工具执行，不使用可重放的共享单次标志。

- 完成：核心24项、UI/预览与发现及6项Host集成通过；新增真实终端场景通过。独立审查修正任务元数据泄漏，保留旧工具返回格式。最新全量445 pass / 16 skip / 0 fail，真实Mac 15 pass，check通过。完整证据及测试环境加载说明见 ../../verification/temporary-tools-2026-10-29.md。未提交或推送。
