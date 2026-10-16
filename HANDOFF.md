# My Agent 开发交接

更新：2026-10-16（Asia/Shanghai）。这是新机器接续开发的入口；旧文档中不同日期的测试数量、父工作区路径和“不提交”说明属于当时的记录。用户现在已明确要求整理并推送必要文件。

## 1. 当前状态和产品目标

仓库：[lllzh0/my_agent](https://github.com/lllzh0/my_agent)，开发分支 `main`。底座为 OMP（oh-my-pi）18.10.3，继承基线 `7414b7c919b59dd14db354a8f6b9164426237dff`。产品包 `packages/workflow-agent`，版本 0.2.0；优先在这个包修改产品行为，底座兼容改动集中在 `packages/coding-agent`。先读仓库 `AGENTS.md`，其中默认包指向上游 coding-agent，不代表产品代码全部在那里。

用户希望降低不同工作流的技能、插件和全局指令相互干扰：以后通过预设明确选择哪些资源加载。编程与资料研究同等重要。四个阶段是：补齐基础工具 → 实现工作流预设 → 试用迭代 → GUI。

**目前仍在第一阶段。** 已有受控工具、研究、会话、MCP、基本命令和文件撤销，可以进行源码试用；完整预设和 GUI 未做，第一阶段整体也未被用户验收。当前只要求面向有编程基础的 TUI 使用者，接受配置文件、环境变量和手动恢复命令，不要求完整配置向导或会话浏览器。

早期 Pi 原型保留在原机器的父工作区，未放入本仓库；当前产品不导入它。不要重新从 Pi 开发，也不要启动原生 OMP CLI 后把其全部能力当作本产品已适配。

## 2. 新机器开始开发

已验证且准备脚本接受的平台：**macOS Apple Silicon（arm64）**，Bun **1.3.14 或更高**，需要 Git。当前命令沙箱只实现 macOS；Intel Mac、Linux、Windows 需要先做平台适配，不能通过关闭沙箱跳过。

```sh
git clone --branch main https://github.com/lllzh0/my_agent.git
cd my_agent
bun --version
bun run agent:prepare
bun run agent doctor
bun run agent --demo
```

`agent:prepare` 按 `bun.lock` 安装指定 workspace 依赖，不执行依赖安装脚本；生成工具视图，并下载、校验同版本官方原生组件。需要 npm registry 网络，不需要编译 Rust。`node_modules`、原生二进制和生成文件没有提交；新机器必须重新准备。不要用 npm 重写锁文件，类型检查使用 tsgo，别换成 tsc。

离线演示只验证入口，不代表真实模型效果：

```sh
bun run agent --demo --print --prompt '确认可以离线启动'
bun run agent --demo --cwd /你的项目绝对路径
```

真实服务选定为 OpenCode Go 的 `deepseek-v4.1-flash`，默认搜索 Tavily。只在新机器自己的终端设置 `OPENCODE_API_KEY`、`TAVILY_API_KEY`，不要把值放进源码、handoff 或聊天。然后执行：

```sh
bun run agent setup --defaults
bun run agent doctor
bun run agent --cwd /你的项目绝对路径
```

默认配置与会话在 `~/.my-agent-omp`；可用 `--home` 或 `MY_AGENT_HOME` 指定独立目录。`doctor` 不发送真实服务请求；`diagnose` 默认只预览脱敏元数据。

个人配置、密钥、会话及原始响应没有推送。原有资源选择使用绝对路径，新机器需要重新选择；旧会话还绑定工作区和资源签名，不保证直接跨机器恢复。这里交接的是开发源码、产品决定和待办，新机器先新建产品会话即可。

## 3. 已实现的能力

| 范围 | 当前行为 |
|---|---|
| 产品入口 | `bun run agent`；setup、doctor、diagnose、demo、print、指定 cwd、手动 resume |
| 资源隔离 | 显式选择指令/技能；不自动发现祖先/全局/项目 AGENTS、设置、模型覆盖、扩展或 MCP；轻量模式不带工作流资源和工具 |
| 文件与命令 | OMP 原生 read/write/replace-edit 外加路径和批准检查；受控搜索、后台命令、日志游标及进程组取消 |
| 权限与沙箱 | 计划/执行模式；副作用逐请求批准；macOS 沙箱，失败不裸跑；保护凭据和产品状态 |
| 研究 | Tavily、网页、普通文本及文本 PDF、来源记录、引用来源检查和报告保存；无 OCR |
| MCP | 显式 HTTP/本地 stdio 服务；连接和业务调用分别批准；启动时快照、按需连接、退出清理，不自动重放未知结果的请求 |
| 任务和会话 | 带证据的任务状态；恢复时检查工作区/资源签名；会话独占，避免历史与产品状态分离 |
| 诊断 | 错误分类、脱敏报告、失败/取消时的模型流摘要；不保存凭据或原始请求正文 |
| 基本命令 | 帮助与补全共用清单；context、effort、usage、fresh、tools、jobs、todo、mcp、plan；session 仅信息，compact 仅摘要 |
| 重试与撤销 | `/redo` 是 `/retry` 同义词；`/undo` 撤销最近一次 agent 运行的直接文件修改，保留聊天并通知模型 |

完整命令与恢复边界见 [基本命令](docs/workflow-agent-basic-commands.md) 和 [包说明](packages/workflow-agent/README.md)。

重要决定：

- `/redo` 不表示恢复被 undo 撤掉的内容；两种拼写走相同重试入口。
- `/undo` 按一次 agent 运行分组，重试是新的运行；只覆盖已记录的 write/edit/write_report 文本修改。shell、Git、MCP 和外部服务不回滚。
- 有后续人工编辑则拒绝覆盖；预检冲突不写文件。运行中、有排队消息、后台任务正在启动/运行或计划模式下不恢复。多文件恢复不是磁盘事务，执行中错误可能部分完成。
- 撤销后重试会带着已保存的通知和工具结果请求模型，不直接重放旧工具批次；立即取消重试也保留通知。普通重试沿用 OMP 行为。
- 产品输入路由失败时拦截原文本；等待人的预览/批准暂停输入钩子的超时计时，防止长时间阅读后命令漏到原生入口。
- 原生 `!`、Python、eval、子 agent、LSP、第三方代码扩展以及未适配命令没有隐式开放。不要为了通过检查绕过这些边界。

## 4. 代码地图及上游同步注意点

| 路径 | 用途 |
|---|---|
| `packages/workflow-agent/src/launcher.ts`、`cli.ts` | 独立进程环境、命令行与 TUI 启动 |
| `src/runtime/host.ts`、`resources.ts`、`tools.ts` | SDK 组装、显式资源、受控工具 |
| `src/policy/`、`processes/` | 路径/批准、后台进程和 macOS 沙箱 |
| `src/changes/`、`tui/commands.ts` | 修改记录、恢复保护、产品命令 |
| `src/research/`、`workflow/`、`mcp/` | 研究来源、任务及受控 MCP |
| `src/diagnostics/`、`src/prompts/` | 脱敏诊断与静态提示模板 |
| `packages/workflow-agent/test/` | 本地 HTTP 模型、真实临时文件与沙箱回归 |

表中 `src/` 均相对产品包。升级 OMP 时重点保留以下可选接口与默认兼容行为：

1. Settings 的 `discoverProjectSettings`、单技能扫描 `includeChildren`。
2. InteractiveMode 的显式快捷键、恢复命令、产品补全表。
3. SessionManager 的独占写入，不自动迁移会话身份。
4. MCP 的隔离环境、进程组、诊断、同源重定向和独立关闭超时。
5. ExtensionRunner 的产品输入失败策略、对话超时预算、`ExtensionContext.signal`。
6. AgentSession/TurnRecovery 的可选 `skipCustomTypes`，保留撤销通知。

原生模型协议、会话存储、终端渲染和文件编辑引擎仍复用 OMP。工具定义的 `__isToolDefinition` 标记、文件语法限制、Sandbox Runtime 0.0.50 最终规则顺序不可凭升级猜测删除。

## 5. 当前证据与未解决事件

最近已取得的证据：产品 92 项普通测试及单独 3 项真实 macOS 沙箱测试通过；基本命令相关底座测试 150 项通过；产品 lint/format/tsgo、底座类型检查及离线 PTY 试用通过。提交前新复跑的准确范围见 [本次验证摘要](docs/verification/handoff-2026-10-16.json)，不要把不同批次的数量相加成覆盖率。

曾用真实 Exa 免密钥 MCP 跑通搜索、网页读取和来源报告链。它没有自动替换默认 Tavily，服务可用性与额度可能变化。

用户曾报告“创建 probe.txt 后读取卡住”。已确认文件读取成功且约 25 毫秒；之后模型只输出 3 个思考字符，约 96 秒后被取消。完整产品请求重建显示思考回传及工具结果配对正常；**远端/网络/协议的具体原因未确定，没有稳定复现，不能说已修好真实服务停顿。** 已增加失败/取消时的 `model-stream.json` 摘要，详见 [调查](docs/workflow-agent-read-stall.md)。不要从别的进程、应用或历史中取得密钥来复测。

其他未验证边界：真实 OpenCode Go/Tavily 的完整任务、真实限流/断网/长期质量、磁盘故障、其他平台和终端、复杂扫描 PDF、完整 OMP/Rust 全仓检查。

## 6. 下一轮建议与当前缺口

以下已做代码核对和优先级讨论，**尚未实现，也不是本次整理/推送任务的范围**。新开发先确定具体任务；建议在第一阶段继续补：

| 优先级 | 待办 | 当前限制与目标 |
|---|---|---|
| P0 | 搜索完整性 | grep 仅字面匹配、只检查前 500 个扫描文件；find 是子串匹配；补正则、路径筛选、忽略规则和明确截断状态，优先复用 OMP |
| P0 | 长会话记录保留 | 100 条文件修改/约 18 MB 快照和 200 条来源上限会阻止继续工作；需要清理/归档/去重及提前提示，不能让模型无声丢证据 |
| P0 | 持续开发授权 | 当前会话批准只复用完全相同请求；提供用户主动开启的项目/操作范围授权，避免每次改内容都批准，同时保留危险操作检查 |
| P0 | 开发环境通道 | 命令默认无联网域名、禁写 `.git`、环境变量有限；按需配置包源、必要工具链路径和明确选定变量；Git 写操作另行授权 |
| P0 | 长文续读 | 网页/文档通常只返回前 12,000 字符，缺按来源/页码继续读与检索；区分已抓取和模型实际看到的片段 |
| P1 | 日常开发效率 | 全任务 diff（含 shell 修改）、多文件操作、受控模型切换、项目测试/类型检查命令衔接 |

LSP 不是第一阶段硬门槛，先用项目 lint/typecheck/test 反馈；子 agent 和浏览器自动化按实际任务决定，不默认扩张。完整预设仍属第二阶段，GUI 属第四阶段。

真实验收另见 [六项任务清单](docs/workflow-agent-acceptance.md)，包括三项编程和三项研究，最终由用户确认，自动测试不能代替。

## 7. 常用验证命令

```sh
bun run --cwd packages/workflow-agent check
bun test packages/workflow-agent/test
bun run --cwd packages/coding-agent check:types
bun test packages/coding-agent/test/interactive-mode-prompt-template-autocomplete.test.ts \
  packages/coding-agent/test/agent-session-manual-retry.test.ts \
  packages/coding-agent/test/extensions-runner.test.ts
MY_AGENT_SANDBOX_TEST=1 bun test packages/workflow-agent/test/sandbox.test.ts
git diff --check
```

前三类自动测试使用临时目录和本机假服务，不需要真实模型或搜索密钥。最后的沙箱组必须能调用系统 sandbox-exec；在 Codex 外层沙箱里可能被系统拒绝，保持产品隔离并在普通 macOS 终端复跑。

## 8. 交接文件范围

推送包括产品源码、测试、静态提示模板、依赖锁、必要 OMP 兼容补丁、文档及脱敏验证摘要。`.gitignore` 保留 `src/changes` 源码例外，并忽略本地状态、环境文件、产物、日志和根目录临时探针。

原机器父工作区的旧 Pi 产品、`validation/` 历史脚本、原始 `artifacts/`、个人配置/会话和 `add.ts`/`add.test.ts`/`probe.txt` 不随仓库上传。历史文档提到这些路径仅表示原机证据；新机器用仓库内测试和上述准备命令继续，不需要那些目录。需要原始日志时由用户另外保管，不把用户会话放入 Git。

## 给下一位开发 agent 的起始说明

> 请先读 AGENTS.md、HANDOFF.md 和 packages/workflow-agent/README.md。当前基于 OMP 18.10.3，产品包是 packages/workflow-agent，仍在第一阶段，编程与研究同等重要。保留既有隔离和权限检查，不自动进入预设/GUI，不使用真实凭据或付费调用代替离线回归。先检查 Git 状态和本机平台，按 HANDOFF 的下一轮待办确定本次范围，再继续实现。
