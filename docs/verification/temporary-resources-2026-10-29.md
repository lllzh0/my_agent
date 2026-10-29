# 临时技能与 MCP 授权验收 · 2026-10-29

起点 `eae675cc32`，OMP 18.10.3、Bun 1.3.14、macOS arm64。用户批准在原临时工具授权上增加已登记技能和已配置 MCP 的单次/当前运行授权。本轮代码、测试和文档未提交、未推送，没有新增依赖或修改锁文件。

## 实际行为

- TemporaryAccess 按 tool / skill / mcp 分开记录授权，共用人工审批队列。取消、撤销、关闭和等待期间的版本变化使旧批准失效；单次调用不留下可重放凭证。旧 `approveTool` 保持兼容，新 `approveResource` 支持三类申请。
- 技能候选只来自共享配置与当前预设的显式路径。`$brainstorming 参数` 可申请“仅加载这次”或“本次Agent运行有效”；模型使用 `request_skill`。`/skills` 提供状态、运行期启用、撤销和清空，斜杠列表仍只显示命令。
- 技能加载使用批准时的 SKILL.md 正文快照，保留原生技能消息、参数与队列路径；底层 Skill 只新增可选 content，未提供时保留原文件读取行为。只增加包内读取，写入、工具、联网等限制不变；单次读权限在本轮结束时收回，运行期权限撤销后立即收回。已载入聊天的正文仍保留。
- MCP 候选只来自共享配置中有效且未禁用的服务。`request_mcp` 和 `/mcp temporary` 先发现目录再申请指定工具；底层 `mcp_list` / `mcp_call` 产品工具、连接和原业务操作审批各自生效。授权绑定服务、具体工具和原始参数结构，脱敏目录仅供展示，不参与授权指纹计算。
- 临时 MCP 单次结束或取消后断开，运行期可复用；撤销只断开拥有的临时连接，基线连接保留。配置和工具定义在审批期间变化时，最终连接/调用前拒绝执行。SDK 的工具目录缓存被显式刷新；取消、超时或结果不明均不自动重试。
- 运行期授权只在同一 Host 内保留，同进程新建/恢复对话可继续使用，退出、重启、冷恢复或预设交接清空。预设文件、共享配置和身份摘要不因临时授权改写。轻量模式无入口，模型来源管理命令拒绝，非交互能力申请默认拒绝。

## 失败回归与审查

1. 接线前真实 Host 的四项新流程均失败；接线后四项通过。首轮 MCP 目录缓存问题出现 59 pass / 1 fail，修正缓存刷新后通过。
2. 自审补三项失败回归：未选同名候选不能遮住预设已选技能；未选 MCP 不提前注册到活动管理器；等待批准期间工具定义变化不能执行业务调用。三项先失败再修复。
3. 独立审查复现四项问题：人工 MCP 授权用脱敏定义计算指纹、原操作审批期间配置改变仍执行、技能首次读取期间结束轮次仍挂上单次权限、长理由挤掉真实详情。另补共享撤销后技能读取根未及时撤下的回归。六项回归（含连接阶段配置变化）修复前 0 pass / 6 fail，修复后通过。
4. 修复后 MCP 12 pass / 0 fail；共享授权、技能与资源界面 35 pass / 0 fail。独立复审重新运行相关四文件 47 pass / 0 fail，并检查差异，未发现新的阻断问题。
5. 新真实终端技能测试最初在拒绝后退出超时：驱动只等待“就绪”标题，菜单尚未关闭便发出 `/quit`。改为等待菜单关闭和拒绝提示后，两条新终端流程通过；没有据此改动产品输入机制。

## 最终检查

所有顶层 Bun 命令和验收子进程均显式 `--no-env-file`。使用临时目录、假密钥、本机模型和 HTTP MCP，不读取真实环境文件、不发付费模型请求、不访问外部 MCP。真实终端指实际启动产品 launcher 和 Ink 界面，模型响应由本机测试服务提供。

| 检查 | 结果 |
| --- | --- |
| 完整产品回归 | 498 pass / 16 skip / 0 fail，2705 assertions；63 文件，303.24 秒 |
| 产品 oxlint / oxfmt / tsgo | 通过 |
| 底层 coding-agent oxlint / oxfmt / tsgo | 通过 |
| SDK 技能快照、技能消息及技能解析 | 65 pass / 0 fail，149 assertions |
| macOS 实际隔离与终端组合 | 17 pass / 0 fail，185 assertions；45.37 秒 |
| 独立复审 | 相关四文件 47 pass / 0 fail，差异检查通过 |

```sh
bun --no-env-file test packages/workflow-agent/test
bun --no-env-file run --cwd packages/workflow-agent check
bun --no-env-file run --cwd packages/coding-agent check
bun --no-env-file test packages/coding-agent/test/temporary-skill-snapshot.test.ts packages/coding-agent/test/skill-prompt-message.test.ts packages/coding-agent/test/skills.test.ts
MY_AGENT_SANDBOX_TEST=1 bun --no-env-file test packages/workflow-agent/test/sandbox.test.ts packages/workflow-agent/test/ink-acceptance.test.ts
```

macOS 专项在允许实际运行系统隔离的宿主上执行，未关闭产品隔离。覆盖技能包读权限撤销、受控命令、MCP 子进程回收、旧工具单次/运行期授权、详情返回不授权、同窗口预设切换与恢复、取消准备、失败保护，以及新增技能/MCP 流程。

本机原始日志位于 `/tmp/temporary-resources-product-full.log`、`/tmp/temporary-resources-real-mac.log`、`/tmp/temporary-resources-final-check.log`、`/tmp/temporary-resources-final-sdk-check.log`、`/tmp/temporary-resources-sdk-tests.log`，可能被系统清理，各组有重复覆盖，不相加为总数。

## 尚未验收

未做本轮 Windows 实机、远端/付费 MCP、真实模型及长期断网/限流测试。Windows 隔离 stdio MCP 继续受原有限制；原 Windows 隔离初始化问题保留。自动测试和独立审查不代表用户已亲手接受，也不代表已经提交、安装、推送或发布。
