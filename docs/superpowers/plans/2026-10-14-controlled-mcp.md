# 第一阶段：受控 MCP 接入实现计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. 用户已授权继续第一阶段，本记录细化 F08/F09，不新增产品阶段或提交授权。

**Goal:** 在 OMP 产品入口连接用户选定的外部工具，同时保留资源选择、批准、取消和退出清理。

**Architecture:** 复用 OMP MCP 客户端与传输层；产品只公开 `mcp_list` 和 `mcp_call`，按需连接，不使用全局发现、自动重连或服务端指令注入。本地服务复用产品现有沙箱，远程服务限制在配置的来源，工具调用逐次经过产品授权。

**Tech Stack:** Bun、OMP MCP client/stdio/HTTP、现有 Policy 和 Sandbox、Bun 本地 HTTP/stdio 测试服务。

**Spec:** 父工作区 `docs/superpowers/plans/2026-10-11-phase-1-agent-implementation.md` 的 F03、F08、F09、F10；本 fork `docs/superpowers/specs/2026-10-13-workflow-agent-omp.md`。

## 范围和验收

- 第一阶段仍以 macOS 为执行平台；无新依赖、全局安装、真实凭据调用、Git 提交或发布。
- 支持 Streamable HTTP 与本地 stdio；OAuth、旧 SSE、任意第三方宿主代码扩展明确显示未接入。
- 可选服务失效只影响该服务；轻量模式不连接；模型不能新增配置或扩大范围。
- 首次连接须批准（启动程序本身也有副作用）；每次业务调用按目标和完整参数授权。计划模式禁止连接/调用。只读提示不代替授权。
- 本地 MCP 继承环境关闭、进程组清理、执行进入同一个沙箱；不自动安装包。本地服务自身修改文件不承诺自动撤销。
- 远程凭据只读取 `${ENV_NAME}`，禁止内联凭据、命令取密钥及跨来源重定向；连接目标不跟随项目发现。
- 超时/断线/取消不自动重放业务调用，提示外部结果可能未知。
- 配置变更保存后重启生效，当前连接使用启动时快照。回退只需删除配置中的 MCP 项，不回退或覆盖用户文件。

## Task 1：底层可选控制

文件：`coding-agent/src/mcp/{client,types}.ts`、`transports/{stdio,http,header-policy}.ts`、对应 MCP 测试。

- [x] 测试先证明：显式隔离配置不继承父环境；macOS 分离进程组的后代随连接关闭；同来源策略阻止向重定向地址发送请求。
- [x] 为 stdio 增加可选 `inheritEnv`、`detached`、取消信号；默认行为保持上游原样。连接取消在 spawn 前复查，关闭完成后再返回。
- [x] 为远程传输增加可选 `redirectPolicy: "same-origin"`，复用 `mcpFetch`，跨来源跳转抛错。
- [x] 运行现有 header-policy、stdio 与连接取消测试。

## Task 2：产品连接管理与工具

文件：新增 `workflow-agent/src/mcp/{config,manager}.ts`；修改 state/host/tools；新增静态工具说明和 `test/mcp.test.ts`。

- [x] 本地 HTTP 夹具验证冷启动零连接、批准连接后列工具、拒绝调用无副作用、允许调用回传结果、断开/重连、取消与不重试。
- [x] `ManagedMcp(configs, policy, sandbox, cwd, stateDir, light)` 保存配置快照；提供 `status()`、`list(name?, signal?)`、`call(name, tool, args, signal?)`、`disconnect(name)`、`close()`。
- [x] 每服务最多一个操作；关闭会取消正在进行的操作并清理连接。调用只允许已列出的工具；返回内容作外部数据，服务端 instructions 不进入系统提示。
- [x] 接入 host 创建/退出，先关闭 MCP 再停止共享沙箱；轻量工具集为空。
- [x] 实际 macOS 子进程验证沙箱路径限制、凭据环境隔离、显式变量传递、进程组清理。

## Task 3：用户可操作入口与交付记录

文件：`workflow-agent/src/tui/extension.ts`、配置菜单模块、README/CHANGELOG、父工作区 NEXT/acceptance。

- [x] `/agent` 可查看 MCP 配置、连接状态、工具列表及错误，手动连接/断开；添加 HTTP/stdio、停用服务保存后重启。
- [x] 表单只收环境变量名，不收密钥；错误保留旧配置并给出具体字段。
- [x] 包级 check/test、针对性上游检查、自查/独立审查可用性记录；真实终端验证菜单。
- [x] 更新证据与续接；真实服务、六项真实任务、独立分发仍分开记录，不冒充第一阶段已验收。

## 本批验收记录

2026-10-15：产品 51 项、原生 MCP 94 项通过，包级静态/格式/类型通过，真实 macOS 沙箱与终端配置/连接/断开通过。独立 MCP 审查的三项发现已修复复测。详见 `docs/workflow-agent-mcp.md`，本地日志在父工作区 `artifacts/omp-mcp/`。真实第三方服务、六项任务及安装分发尚未验收；本批完成不等于第一阶段完成。

原入口补查另修复两项已复现回归：shell 正常退出后的同组子进程残留、批准期间切计划模式仍放行。代码改动限于 Supervisor 和 Policy，对应回归加入现有 processes/core 测试，不扩展新功能。原入口完整独立审查仍待取得最终结论。
