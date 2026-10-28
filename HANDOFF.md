# My Agent 开发交接

最新界面优化（2026-10-28）：先将取消优化提交为 `031d44c037`，未推送；然后依次改善编辑审批、命令结果。写入审批区分创建/覆盖，显示旧新差异、增删量及覆盖边界，长替换片段先计算差异再裁剪；审批期间目标变化时拒绝写入，Windows 盘符路径可正常使用。命令结果独立模块供前台、后台日志和停止共用，保留日志首尾、用时、目录与游标，保留模型数据契约。win/mac 共用实现，不复制 UI 分支；Windows 实际文件/命令链路与定向测试已验证，macOS 实机待回归。两项界面改动尚未提交。验证和旧 journal 的 Windows 环境限制见 [本轮记录](docs/verification/approval-command-ui-2026-10-28.md)。下方“尚未提交”以本节和 Git 为准。

前一保存与优化（2026-10-28）：批次 1/3 和 Windows 支持已按用户要求提交为 `5ea44a5eb8`，未推送。随后最小修复 Windows 初始化等待不能及时取消的问题：回归先失败后通过，真实取消约 3.76 ms，无落盘副作用，后续命令成功，现已提交为 `031d44c037`。热准备只占约 0.2–0.3 秒，原生启动仍约 9–11 秒；固定上游源码确认 MCP stdin 在发送内部配置后被关闭，门控继续保留。范围、证据及边界见 [Windows 验证](docs/verification/windows-2026-10-28.md)。下方批次“未提交”描述属于保存点之前。

Windows 优先批次（2026-10-28）：已接入 Windows 原生包、PowerShell、进程树取消、路径限制和 0.0.81 Windows alpha 沙箱，macOS 保留原依赖。用户确认后已安装本机账户/WFP，真实命令隔离通过 26 次断言；使用用户提供的密钥完成 OpenCode Go / DeepSeek V4.1 Flash 的 `max` 思考、沙箱命令及自然回复链路，第二轮模型延迟约 272 秒。产品 tsgo、x64 组件、CLI/恢复及真实 ConPTY 离线交互已通过。本机隔离 stdin 探针为空，因此普通权限启动前拒绝本地 MCP；显式 full 的真实协议及后代清理通过，HTTP MCP 保留。旧宿主集成超时和全新环境准备未闭合。Windows alpha 本机已观察到匿名令牌 loopback 残余。完整证据见 [Windows 验证](docs/verification/windows-2026-10-28.md)，安装与限制见 [Windows 使用说明](docs/workflow-agent-windows.md)。批次 1/3 改动保留，均未提交、未推送。下方 macOS 独占准备说明为旧基线。

最新开发批次（2026-10-28，批次 1 / 3）：已在 main 工作树接入审批片段差异、只读详情和命令结果摘要，以及命名预设启动最小版。`preset list/create/show/check` 管理清单，`--preset <ID>` 使用独立 SDK 与会话目录，`/preset show` 显示实际状态；模型和 MCP 引用共享配置，不复制凭据。命名预设首批冻结资源，修改清单后重启；原入口保留资源热开关。运行中切换、默认绑定和完整编辑器未做，main 仍为单 agent，未提交、未推送。用法见 [工作流预设](docs/workflow-agent-presets.md)。本机 Windows 的定向验证及依赖安装限制见 [本批验证](docs/verification/batches-1-3-2026-10-28.md)；这不是 Windows 运行时支持或真实 macOS 终端验收。下方历史“预设未开始”等描述以本节为准。

最新验收批次（2026-10-28）：菜单停止修复已先提交为 `ab1cea0147`。随后使用真实墨线 TUI、用户已配置模型和独立临时目录，对 GitHub `escape-string-regexp` 的历史 issue #20 / PR #21 做小型代码任务。模型完成两文件修复，项目 4 项测试、代码和类型检查通过，独立行为检查从 30 通过 / 8 失败变为 38 通过 / 0 失败。首轮方案遗漏字符集合边界，补充验收条件后才完成，不称为一次无提示通过。Issue #41 的加号只读核验也已完成，未复现且源码指纹不变。环境兼容、外层沙箱和额度中断均单列保留；详细流程、证据及边界见 [真实代码验收](docs/workflow-agent-real-code-acceptance.md)。本批仅补充文档；测试没有改变产品代码，也不代表第一阶段整体验收。GUI 已在聊天中比较布局，尚未接入产品。

最新开发批次（2026-10-27）：已在单 agent main 接入墨线 TUI、会话草稿保持、审批自动退让及 F3 分组资源状态页。用户确认资源页改动生效，并明确要求先提交当前成果，再处理“中断后换任务、继续、排队恢复和 retry”的可靠性。范围、自动与真实终端/服务证据见 [墨线验证记录](docs/workflow-agent-ink-tui-verification.md)。没有推送；不把资源页确认扩展为第一阶段整体验收。

保存点：上述界面批次已提交为 `31389b8fb0 feat(workflow-agent): add ink terminal workspace`，提交后工作区干净，未推送。

2026-10-27 中断专项：真实服务的换任务、继续、排队恢复、`/retry` 和连续中断后恢复均通过本次复测；原来的“新输入已发送但模型继续旧列表”尚未稳定复现，仍保留为观察项，不能宣称修复。另确认并修复了菜单停止的问题：Ctrl+P → 停止当前回答曾在取消后自动发送排队消息；现在复用 Esc 的队列恢复处理，保留草稿。新增实际终端回归先失败后通过；相关 34 项测试和产品 check 通过，修复后的真实模型菜单停止也通过。用户随后已授权提交该专项，提交号以 Git 记录为准；未推送。详细证据和范围见 [中断专项验证](docs/workflow-agent-interrupt-verification.md)。

最新保存批次（2026-10-21，OMP 上游稳定性回移）：资源热开关已先保存为 main `5ae2bb2f29`、协作 `aa37e2fe13`。三批上游修复随后集成到 main，并同步到 `codex/team-scheduler-wait`；main 保持单 agent。模型通信/会话写盘、取消恢复/失败计量、通用显示/MCP/读取三批的 main 提交分别是 `7216f18627`、`115d1d3444`、`2b87fdd96b`，协作对应 `cf2757bef0`、`3f9d8b7c9f`、`6e0f44695e`。全部仅保存在本地，未推送。下方旧“未提交”等描述是历史记录，以本节和 Git 状态为准。

本批完整产品回归：main **266 pass / 6 skip / 0 fail**，协作 **409 pass / 6 skip / 0 fail**。最终专项：AI 232、原生会话/MCP/SDK/写盘/读取 138、原生 read tool 75、TUI 10、fetch retry 37 项通过；AI/catalog/utils/agent/coding-agent/TUI 及两份产品包的 lint、格式和类型检查通过。两分支共享原生包目录一致，55 个回移文件逐一比对一致，产品源码未在这次回移中改变。详见 [上游来源与适配](docs/workflow-agent-upstream-backports.md) 和 [本批验证](docs/verification/upstream-stability-2026-10-21.json)。

使用现有源码入口，重启正在运行的 agent 后生效；默认 OpenCode Go 地址已更新为 inference/go，显式配置的 baseUrl 保持优先。真实服务、人工终端和六项选择性真实沙箱验收未做；上游审查代理触及额度，最终差异由主代理复查，没有独立最终签字。后续先验收真实模型的写文件→读文件、Esc→retry/redo、MCP 取消及展开长输出，再继续完整预设设计；不要将本次底座回移视为整体升级 OMP。

最新开发批次（2026-10-21）：通用资源开关已在 main 和 `codex/team-scheduler-wait` 两工作区实现，未提交、未推送。`/resources`（也可从 `/agent` → 修改资源选择进入）管理产品工具、显式技能、指令文件和自定义/附加提示词；空闲时热切换并保存配置，下一次请求生效；`reload` 重新读取文件及技能元数据。完整预设尚未实现，main 仍保持单 agent。用法、范围和恢复限制见 [通用资源开关](docs/workflow-agent-resource-switches.md)。

本批验证：完整产品回归曾通过协作 407 pass / 6 skip、main 265 pass / 6 skip；随后补齐旧工具清单等量替换和技能文件缓存两个边界，最终专项分别 20 / 11 pass，会话/宿主回归分别 45 / 46 pass，均 0 fail。OMP 相关测试合计 104 pass，两分支包内 oxlint、oxfmt、tsgo 及 diff 检查通过。源码摘要与各轮范围见 [验证记录](docs/verification/resource-switches-2026-10-21.json)，不要将此前全量数误称为最终树重新全量运行。六项真实 macOS 沙箱检查仍跳过，人工终端和真实模型效果未验收。独立审查提出的菜单忙碌和沙箱读取范围两项已修复；审查代理在最终报告时达到额度，末轮差异复查由主代理完成，无独立最终签字。

本批保持原有边界：关闭技能/指令不会擦除历史上下文；选择按当前配置目录保存，其他旧会话仍须匹配资源才能恢复。MCP 服务配置仍按原流程重启，OMP 代码扩展未开放。后续先由用户试用菜单、开关和 reload；完整预设设计应复用本批原地切换能力，同时保持切换进入独立会话的已确认决定。

第二阶段设计草案已落盘：[工作流预设设计](docs/superpowers/specs/2026-10-20-phase2-presets-design.md)。用户已确认切换进入独立会话、旧聊天搬运延后、先管理 MCP/技能而不开放 OMP 代码扩展。草案尚未提交、完整设计待审阅，完整预设代码未开始；后续从 main 保存点建功能分支，再向协作分支同步共享能力。

最新保存点（2026-10-20，Asia/Shanghai）：第一阶段已约定的功能开发收尾，真实服务与人工验收仍独立保留；第二阶段进入预设设计，尚未开始编码。本次本地提交包含默认消息统计及其测试、文档，main 保持单 agent，未推送。下文“未提交”等描述属于历史记录，以本节为准。

本次完整产品回归 **255 pass / 6 skip / 0 fail**，1387 次断言，32 个测试文件；包内 oxlint、oxfmt、tsgo 通过。6 项真实 macOS 沙箱检查本次未重跑，未进行真实服务或人工终端验收。详见 [保存点验证](docs/verification/phase1-checkpoint-2026-10-20.json)。后续只对第一阶段实际阻断做定点修复，不自动扩充功能清单。

最新共享功能（2026-10-19）：main 和 `codex/team-scheduler-wait` 均已默认开启每条模型消息的平均 TPS 与首个输出等待时间，普通/轻量模式及恢复会话生效；直接复用 OMP 的 `display.showTokenUsage`，不新增第三方插件、模型请求或提示词。需重启产品入口；每条消息结束后显示统计条。TPS 包含首字等待，TTFT 包含思考/工具调用首块，缺失数据不补造；详见 [消息统计](docs/workflow-agent-message-metrics.md)。

本批针对性回归：协作分支 72 pass、main 73 pass，均 0 fail；原生显示/历史回放/状态吞吐回归 34 pass、0 fail；两个包内 check 通过。未重跑整套产品测试，以下历史完整测试数属于此前保存点。真实服务与人工终端视觉验收仍未做。两工作区都保留未提交的本批改动、未推送，协作分支先前未提交成果也保留；main 仍是单 agent。主工作区在协作分支，main 位于父目录 `.worktrees/main-sync`。源码哈希、测试和分支记录见 [本批验证](docs/verification/message-metrics-2026-10-19.json)。

更新：2026-10-18（Asia/Shanghai）。本地单 agent 基础同步已保存为 `443d1498a4`，协作原有工作保留为其后继 `b9104e5789`。用户明确要求 `main` 保持单 agent，多角色协作留在 `codex/team-efficiency`。本轮新增模型管理、新会话、差异审查、MCP 来源桥接；公共功能独立审查和最终整套回归已通过（251 pass、6 skip、0 fail），接下来整合协作分支；未推送。

新增功能用法见 [第一阶段日常功能](docs/workflow-agent-daily-use.md)。批准范围与剩余任务见 [实现计划](docs/superpowers/plans/2026-10-17-phase1-completion.md)。协作角色模型选择和共享预算在公共功能审查完成后实现。真实服务、终端试用和人工验收仍单独保留。公共功能的离线结果见 [验证记录](docs/verification/phase1-shared-2026-10-18.json)。

## 1. 当前状态和产品目标

仓库：[lllzh0/my_agent](https://github.com/lllzh0/my_agent)，当前分支 `main`。底座为 OMP（oh-my-pi）18.10.3，继承基线 `7414b7c919b59dd14db354a8f6b9164426237dff`。产品包 `packages/workflow-agent`，版本 0.2.0；优先在这个包修改产品行为，底座兼容改动集中在 `packages/coding-agent`。先读仓库 `AGENTS.md`，其中默认包指向上游 coding-agent，不代表产品代码全部在那里。

用户希望降低不同工作流的技能、插件和全局指令相互干扰：以后通过预设明确选择哪些资源加载。编程与资料研究同等重要。四个阶段是：补齐基础工具 → 实现工作流预设 → 试用迭代 → GUI。

**目前仍在第一阶段。** 已有受控工具、研究、会话、MCP、基本命令和文件撤销，可以进行源码试用；完整预设和 GUI 未做，第一阶段整体也未被用户验收。当前只要求面向有编程基础的 TUI 使用者，接受配置文件、环境变量。按后续明确要求，已接入 `/resume` 当前工作区会话选择器，不要求完整配置向导。

早期 Pi 原型保留在原机器的父工作区，未放入本仓库；当前产品不导入它。不要重新从 Pi 开发，也不要启动原生 OMP CLI 后把其全部能力当作本产品已适配。

## 2. 新机器开始开发

原有验收平台为 **macOS Apple Silicon（arm64）**，Bun **1.3.14 或更高**，需要 Git。新增 Windows x64/arm64 准备入口及原生 alpha 沙箱，实际验证状态以文首 [Windows 记录](docs/verification/windows-2026-10-28.md) 为准；Intel Mac 和 Linux 尚未适配。隔离不可用时不通过自动关闭沙箱跳过。

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
| 文件与命令 | OMP 原生 read/write/replace-edit 与 native grep/glob；产品路径检查、搜索分页及不完整提示；保留现有后台管理、日志游标及进程组取消 |
| 权限与沙箱 | manual/auto/full；auto 独立模型审核，高风险/未知/异常转人工；full 仅当前人显式选择，放开沙箱及目录/网络限制；计划模式独立只读 |
| 研究 | Tavily、网页、文本 PDF、来源内续读/检索；区分返回片段和提取限制；稳定来源 ID、版本去重、引用检查和报告保存；无 OCR |
| MCP | 显式 HTTP/本地 stdio 服务；连接和业务调用分别批准；启动时快照、按需连接、退出清理，不自动重放未知结果的请求 |
| 模型与审查 | `/model` 显式候选/本会话切换、精确连接密钥隔离；`/diff` 有界原始内容差异、`/review` 受控只读子任务、单列统计 |
| 新会话 | `/new` 保存旧记录并重置临时授权；空白和仅审查会话也落盘，可跨进程恢复 |
| MCP 来源桥 | `mcp_call` 返回真实捕获ID，`import_mcp_source` 导入正文或发现记录，保存实际内容和覆盖限制 |
| 任务和会话 | `/resume [ID或唯一前缀]` 选择当前工作区会话，或启动参数 `--resume`；检查工作区/资源签名并保持独占；任务、来源、撤销记录随聊天切换 |
| 诊断 | 错误分类、脱敏报告、失败/取消时的模型流摘要；不保存凭据或原始请求正文 |
| 基本命令 | 帮助与补全共用清单；context、effort、usage、fresh、tools、jobs、todo、mcp、plan；session 仅信息，compact 仅摘要 |
| 重试与撤销 | `/redo` 是 `/retry` 同义词；`/undo` 撤销最近一次 agent 运行的直接文件修改，保留聊天并通知模型 |
| 目标和旁问 | `/goal` 原生目标、预算和续跑，冷恢复先暂停；`/btw` 独立面板和历史，不执行工具或修改主聊天 |

当前用法与范围见 [P0 说明](docs/workflow-agent-p0.md)、[基本命令](docs/workflow-agent-basic-commands.md) 和 [包说明](packages/workflow-agent/README.md)。修改/来源记录已使用 Bun SQLite 按需读取，累计 100/200 条不再硬停；旧 JSON 导入后保留原件。

重要决定：

- `/redo` 不表示恢复被 undo 撤掉的内容；两种拼写走相同重试入口。
- `/undo` 按一次 agent 运行分组，重试是新的运行；只覆盖已记录的 write/edit/write_report 文本修改。shell、Git、MCP 和外部服务不回滚。
- 有后续人工编辑则拒绝覆盖；预检冲突不写文件。运行中、有排队消息、后台任务正在启动/运行或计划模式下不恢复。多文件恢复不是磁盘事务，执行中错误可能部分完成。
- 撤销后重试会带着已保存的通知和工具结果请求模型，不直接重放旧工具批次；立即取消重试也保留通知。普通重试沿用 OMP 行为。
- 产品输入路由失败时拦截原文本；等待人的预览/批准暂停输入钩子的超时计时，防止长时间阅读后命令漏到原生入口。
- 原生 `!`、Python、eval、LSP、第三方代码扩展以及未适配命令没有隐式开放。产品保持单 agent，不开放原生完整 Task 工具。不要为了通过检查绕过这些边界。

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
7. 共享 shell-tokenize 的可选 `allowSingle`；原生默认仍只解析至少两个字面命令的 && 链，产品只接受单条 Git。
8. 会话恢复复用原生选择器、列表与切换；TUI 可传 `keepModel`，退出恢复命令支持动态回调，AgentSession 可设置输入/重试保护。产品 `runtime/sessions.ts` 协调两侧状态，`session-state.ts` 打开/关闭每个会话的资源。选择器仅显示宿主实际提供的删除/全局切换操作。
9. `task/executor.ts` 的现代工具定义、`allowRestrictedCustomTools`、`explicitModel` 和 `hostSystemPrompt` 可选参数。产品用它们保留受控工具与显式服务地址，决策者使用完整宿主提示，默认原生路径不变。
10. SDK 的 `allowRestrictedGoalTool` 显式选项和 `InteractiveMode.getUserInput(signal?)`。产品在非 light 根会话允许隐藏 goal，子实例不开放；`tui/input-loop.ts` 复用原生提交路径。goal 工具的产品钩子只允许查看/完成，管理权属于人；冷恢复补空的审核上下文不能覆盖用户后来追加的限制。

原生模型协议、会话存储、终端渲染和文件编辑引擎仍复用 OMP。工具定义的 `__isToolDefinition` 标记、文件语法限制、Sandbox Runtime 0.0.50 最终规则顺序不可凭升级猜测删除。

## 5. 当前证据与未解决事件

最新 goal/BTW 验证：产品全量 **228 pass / 6 skip / 0 fail**（含 10 项 goal、6 项 BTW）；原生相关 **173 pass**。产品检查、底座类型检查、改动原生文件 lint/格式和 diff 检查通过。独立审查发现的退出竞态、冷恢复审核上下文及后续人类限制覆盖问题均已复现修复，复核无剩余实质问题。实际 PTY 离线操作已覆盖目标启动/预算/暂停/续跑、旁问/历史、退出和重启恢复；真实模型与六项系统沙箱检查本轮未执行。准确边界见 [goal/BTW 验证](docs/verification/goal-btw-2026-10-17.json)。


本轮 P0 自动证据：产品 **157 项普通测试通过**，**6 项真实 macOS 沙箱检查单独通过**，原生相关回归 **223 项通过**；产品 lint/format/tsgo、底座类型检查通过。真实终端离线演示已验证 manual → auto → full、full 下计划状态、切回 manual 及正常退出。准确命令、范围和未验证项见 [P0 验证摘要](docs/verification/phase1-p0-2026-10-17.json)。

旧检查点证据保留在 [handoff-2026-10-16.json](docs/verification/handoff-2026-10-16.json)，不要与新结果相加成覆盖率。新检查仅证明实现和自动回归，不代表真实模型质量或用户已接受第一阶段。

曾用真实 Exa 免密钥 MCP 跑通搜索、网页读取和来源报告链。它没有自动替换默认 Tavily，服务可用性与额度可能变化。

用户曾报告“创建 probe.txt 后读取卡住”。已确认文件读取成功且约 25 毫秒；之后模型只输出 3 个思考字符，约 96 秒后被取消。完整产品请求重建显示思考回传及工具结果配对正常；**远端/网络/协议的具体原因未确定，没有稳定复现，不能说已修好真实服务停顿。** 已增加失败/取消时的 `model-stream.json` 摘要，详见 [调查](docs/workflow-agent-read-stall.md)。不要从别的进程、应用或历史中取得密钥来复测。

其他未验证边界：真实 OpenCode Go/Tavily 的完整任务、真实限流/断网/长期质量、磁盘故障、其他平台和终端、复杂扫描 PDF、完整 OMP/Rust 全仓检查。

2026-10-17 后续修复：用户报告绝对路径放在提示词句首时按 Enter 无反应。已复现为产品输入层把路径当未知斜杠命令并拦截，尚未请求模型；与上述读取后模型停顿是不同问题。路径和命令现在共用明确的分类规则，路径任务也会更新自动授权的任务上下文；保留未适配原生命令及冒号形式的拦截。新增 5 项回归通过，连同命令、host 共 46 项相关检查通过；离线真实终端的路径句首输入、Enter、回复和退出已验证。模型和文件操作使用本地假服务及临时文件，未修改用户的原始文件；真实服务请重启产品后复测原句。

2026-10-17 `/resume` 增量：按用户要求复用 OMP 官方已有列表、选择器和历史切换，新增产品状态协调；详见 [会话恢复](docs/workflow-agent-resume.md)。聊天、任务、来源、文件及撤销记录一起切换；清除临时许可和 full，按当前配置重新授权，保留模型连接及计划模式。界面刷新失败、切换中输入/排队/F5、退出与切换并发均有回归。底座新增宿主保护仅在产品设置 guard 时启用，避免改变原生队列完成时序。

本增量验证：产品 **173 通过、6 跳过、0 失败**（含 **11 项恢复专项**），原生会话/选择器 **37 通过**，输入/队列/重试 **103 通过**；产品及底座/TUI 类型、改动代码 lint/格式、diff 检查通过。真实终端离线检查覆盖选择/取消、旧历史、继续对话、权限与计划状态及退出提示。六项系统沙箱本轮未重跑，真实服务和用户验收仍未完成。摘要见 [resume-2026-10-17.json](docs/verification/resume-2026-10-17.json)，未新增提交或推送。

## 6. 下一轮与第一阶段结束条件

用户要求优先复用 OMP，停止按其他工具命令表逐项补功能。本轮已收尾先前五项 P0：搜索完整性、长记录保留、持续开发授权、开发环境通道、长文续读。自动授权、当前进程完整授权及 /permissions、--permissions 已接通；不以关闭普通模式沙箱绕过失败。

本轮保留原生会话/编辑/摘要/用量及模型客户端，搜索复用 native grep/glob，Git 复用共享严格解析器。后台管理和网页/PDF 获取保留现状，不为去重进行整套重写。独立审查发现的授权解析、Git 组合命令、MCP 等待中的授权变更、长用户任务约束丢失、命令/文件执行时的旧授权空档、超100文件与部分恢复通知、并发来源迁移均已修复并有回归。

接下来按 [六项任务清单](docs/workflow-agent-acceptance.md) 进行三项编程、三项研究试用。真实服务仍为 OpenCode Go / DeepSeek V4.1 Flash、Tavily 或用户选定 MCP；此前模型停顿仍需新证据复测。真实限流、断网、长任务/摘要质量和用户验收不能用假模型测试代替。

第一阶段不再扩张到全命令移植、全局会话管理、配置向导、独立安装器、跨平台、OCR、模型热切换、LSP、原生完整子 agent 管理和浏览器自动化等。按用户后续要求，已加入当前工作区 `/resume`；main 保持单 agent，协作留在独立分支。配置文件、环境变量、重启选模型和手动 --resume 仍可接受。完整工作流预设属第二阶段，GUI 属第四阶段。

若后续发现实际阻断，先复现并定点修复。第一阶段结束仍需用户明确接受，不由自动化设置已验收。

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

此前交接范围包括产品源码、测试、静态提示模板、依赖锁、必要 OMP 兼容补丁、文档及脱敏验证摘要。`.gitignore` 保留 `src/changes` 源码例外，并忽略本地状态、环境文件、产物、日志和根目录临时探针。

原机器父工作区的旧 Pi 产品、`validation/` 历史脚本、原始 `artifacts/`、个人配置/会话和 `add.ts`/`add.test.ts`/`probe.txt` 不随仓库上传。历史文档提到这些路径仅表示原机证据；新机器用仓库内测试和上述准备命令继续，不需要那些目录。需要原始日志时由用户另外保管，不把用户会话放入 Git。

## 给下一位开发 agent 的起始说明

> 请先读 AGENTS.md、HANDOFF.md 和 packages/workflow-agent/README.md。当前基于 OMP 18.10.3，产品包是 packages/workflow-agent，仍在第一阶段，编程与研究同等重要。保留既有隔离和权限检查，不自动进入预设/GUI，不使用真实凭据或付费调用代替离线回归。先检查 Git 状态和本机平台；P0 已完成技术收尾，优先协助真实服务和六项任务验收，遇到实际阻断再修复，不再重复实现 OMP 已有能力。
