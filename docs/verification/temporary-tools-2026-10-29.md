# 临时工具授权验收 · 2026-10-29

基线 `58cce6f8e9`；OMP 18.10.3、Bun 1.3.14、macOS arm64。用户批准仅临时启用工具，保留目录、联网及计划模式检查。原 Mac 验收的测试和文档继续保留。验收完成时代码、测试、文档均未提交或推送；随后用户授权先本地提交，当前提交状态以 Git 为准，未授权推送。

## 实际行为

- `request_tool` 是产品的固定申请入口，独立于预设可选工具清单；普通启动注册，轻量模式不注册。它先列名称和状态，可逐项返回参数结构，再提交具体调用。复用 `toolWireSchema`，支持 edit 的可执行 ArkType 参数结构。
- 人工选择 once/run/deny。once 执行已验证并复制的具体参数，没有共享的“允许下一个调用”标志；run 按工具名保存在当前 Host 内存。等待人工批准期间修改参数、取消、撤销、关闭或策略版本变化，旧批准不会执行。
- 原产品工具仍做文件范围、联网、计划模式、命令隔离、MCP 连接和具体操作审批。auto/full 操作模式不能替人批准新的工具能力；原 `approve` 回调与新 `approveTool` 回调相互独立。
- `/tools`、`/tools list`、`/tools allow <名称>`、`/tools revoke <名称>`、`/tools clear` 提供状态和人工管理。详情只读，打开或关闭详情不授权。模型来源管理命令被拦截，非交互管理写操作拒绝。
- run 跨当前进程内同预设的 `/new`、`/resume` 保留；退出、重启、冷恢复、Host 交接清空。命名预设恢复若启动新的 Host，也会清空。预设文件与身份摘要不修改。
- 临时 bash 产生的任务可以按关联任务 ID 查看和停止；其它任务不能借此读取。旧基线 job_stop 的数组返回合同保留，仅关联任务或单次批准的停止调用过滤其它任务。会话运行时替换清空关联任务凭证。

## 先失败再通过

- Host 接线前：`temporary-tools-host.test.ts` 1 pass / 4 fail。失败包含文件没有被创建、模型来源 `/tools` 尚未被专门拦截。
- 核心首个真实写入测试失败后实现；补 run bash 直接调用收尾回归，23 pass / 1 fail 后修复。
- edit 发现接口最初序列化掉函数型 schema：1 pass / 1 fail。复用现有 schema 转换后两项通过。
- 独立审查发现 scoped job_stop 返回其它任务元数据。补断言后真实复现失败；修复并保留旧返回格式后，核心与命令结果测试 **29 pass / 0 fail / 169 assertions**。
- 新终端驱动最初把详情正文中的“仅此次调用”误当返回菜单；等待真实菜单并排除详情标题后通过。详情实现使用只读 InkDocument。

## 验证命令和证据

所有顶层 Bun 命令显式使用 `--no-env-file`，实际模型地址始终为 localhost，配置使用假密钥；没有调用付费模型、Tavily 或外部 MCP，没有检查或输出真实密钥值。收尾发现旧测试辅助函数的 CLI 子进程没有显式禁用环境文件加载，不能排除最初子进程由 Bun 自动加载了项目 `.env.local`；未查看该文件内容。现已为 CLI 和 Host 测试子进程统一加入 `--no-env-file`，并重新执行相关 Host 与 macOS 专项，最终结果以下方记录为准。

```sh
bun --no-env-file test packages/workflow-agent/test/temporary-tools.test.ts packages/workflow-agent/test/tool-access-ui.test.ts packages/workflow-agent/test/temporary-tool-discovery.test.ts
bun --no-env-file test packages/workflow-agent/test/temporary-tools-host.test.ts
bun --no-env-file test packages/workflow-agent/test/ink-acceptance.test.ts --test-name-pattern 'real terminal grants'
MY_AGENT_SANDBOX_TEST=1 bun --no-env-file test packages/workflow-agent/test/sandbox.test.ts packages/workflow-agent/test/ink-acceptance.test.ts
bun --no-env-file test packages/workflow-agent/test
bun --no-env-file run --filter @my-agent/workflow-agent check
```

- 边界、UI、发现三文件：**42 pass / 0 fail / 205 assertions**，`/tmp/temporary-tools-boundaries.log`。
- 真实 Host 与本地模型：**6 pass / 0 fail / 26 assertions**。验证单次工具不出现在后续 schema、run 后出现在 schema、配置未变、冷恢复清空、`/new` 保留、full 不能代替能力批准、模型管理命令被拦截、资源关闭撤销授权。首次绿测 `/tmp/temporary-tools-host-green.log`，子进程禁用环境文件后的复测 `/tmp/temporary-tools-host-noenv-final.log`。
- 新增真实终端场景：只读详情、单次批准、保留原写入审批、运行期批准、后续直接使用、人工撤销、撤销后伪造调用失败、直观状态和预设文件字节不变；**1 pass / 0 fail / 11 assertions**。`/tmp/temporary-tools-pty.log`。
- 真实 macOS Seatbelt 与完整终端专项：**15 pass / 0 fail / 169 assertions**，首次系统级绿测 `/tmp/temporary-tools-real-mac-final.log`，测试子进程禁用环境文件后的最终日志 `/tmp/temporary-tools-real-mac-noenv-final.log`。首次在外层受限执行环境运行时出现 `sandbox_apply: Operation not permitted`，另有新增控制入口的旧清单断言；没有放宽产品隔离，修正清单断言后在获准的系统执行环境重跑通过。该组与产品测试有重叠，不累加为总数。
- 首次完整产品回归：442 pass / 16 skip / 3 fail。三项为旧 job_stop 返回格式和两处新控制入口工具清单断言；均已修正。最终全量 **445 pass / 16 skip / 0 fail / 2461 assertions / 58 文件 / 294.97 秒**，`/tmp/temporary-tools-product-final.log`。该轮期间仅补齐测试辅助子进程的环境参数，随后相关 Host 6 项及真实 Mac 15 项再次通过；生产实现未再修改。
- 最终静态检查：**oxlint、oxfmt、tsgo 全部通过**，`/tmp/temporary-tools-check-final.log`。Git diff 检查通过，索引为空；六份交接/使用/设计/计划/验收文件的本地链接检查无断链。
- 独立审查已通过，包括关联任务泄漏修正、原返回格式兼容和 edit 参数结构转换；审查者独立重跑48项，再对最终兼容修正重跑29项，均无失败。

## 边界

本轮没有 Windows 实机验证、真实付费服务、远程 MCP 实机、长期挂起审批的压力测试或人工整体接受。审批回调若永久不结束，后续人工审批继续排队，避免界面重叠。没有重新安装依赖、下载原生组件、发布或更改全局权限。技术通过与用户接受分开记录。
