# 当前源码交付与验证

更新：2026-10-29。My Agent 0.2.0，基于 OMP 18.10.3 / Bun 1.3.14。当前交付形式为源码入口，使用同版本官方原生组件；不需要编译 Rust，不提供独立安装器。

## 准备与启动

在仓库根目录运行：

~~~sh
bun run agent:prepare
bun run agent setup --defaults
bun run agent doctor
bun run agent --demo
~~~

准备按锁文件从官方 npm registry 安装产品及工具视图生成器，忽略安装脚本，保留可选依赖并降低网络并发；随后生成工具视图，校验和加载对应平台原生组件。锁文件和依赖版本不因本轮准备修复改变。可选语音/向量运行时不因此自动启用或下载模型。

Windows 命令隔离还需单独的系统安装，见 [Windows 使用说明](workflow-agent-windows.md)。doctor 不发模型请求；其依赖失败应先定位，不自动关闭隔离。首次源码加载在当前 Windows 测试机约 46–53 秒，不能把 30 秒测试截止直接解释为模型或 MCP 超时。

使用 `--home`、`--cwd` 指定配置和项目；密钥在用户自己的启动终端设置。退出后使用产品输出的完整恢复命令。命名预设保留 `--preset`，跨预设恢复拒绝，full 不持久化。

## 当前能力与证据

| 范围 | 状态与证据 |
| --- | --- |
| 编辑审批、命令结果、输入与恢复 | 已实现；[共享 UI 记录](verification/approval-command-ui-2026-10-28.md)、[macOS 终端验收](verification/mac-preset-2026-10-28.md) |
| 文件格式、撤销、摘要及压缩队列 | 已回移并审查；Mac 产品 359 pass / 16 skip / 0 fail，见 [稳定性验收](verification/upstream-stability-2026-10-28.md) |
| Windows 最新回归与准备 | 专项 99 pass、宿主筛选 7 pass；空缓存完整 prepare、离线启动和 check 通过；真实隔离初始化仍失败，见 [批次 1 验证](verification/batch1-cross-platform-2026-10-29.md) |
| 预设管理与终端交接 | 已实现草稿、资源、默认绑定及空闲交接/取消/失败回退；Windows 真实模型 A/B/A 通过，未激活目标写入暂存；[使用方式](workflow-agent-presets.md)、[批次 3 证据](verification/batch3-terminal-handoff-2026-10-29.md) |
| Mac 管理交接补验（临时工具授权前） | 路径夹具修正、实际 PTY 管理/交接、权限重置、MCP 关闭、新源码/空缓存准备及同文件冷恢复通过；该轮全量396 pass / 16 skip / 0 fail，真实沙箱/终端另行14 pass；[Mac 验收](verification/mac-preset-handoff-2026-10-29.md)。本机受控模型，不代表真实服务或人工接受 |
| 临时工具授权 | 单次/当前运行期人工授权，保留原策略和操作审批，支持管理/撤销和关联任务收尾；最新全量445 pass / 16 skip / 0 fail，真实 Mac 隔离/终端15 pass，静态检查及独立审查通过；[用法](workflow-agent-presets.md#临时使用预设未启用的工具)、[验收与环境边界](verification/temporary-tools-2026-10-29.md)。本地提交与同步状态以 Git 为准；未推送或做 Windows 实机验证 |
| 临时技能与 MCP 授权 | `$名称` 单次加载、`/skills` 管理，`/mcp temporary` 按具体工具授权；本轮全量498 pass / 16 skip / 0 fail，真实 Mac 隔离/终端17 pass，SDK 技能回归65 pass，静态检查和独立复审通过；[用法](workflow-agent-presets.md#临时使用-skill-和-mcp)、[验收](verification/temporary-resources-2026-10-29.md)。本轮改动未提交、未推送，未做 Windows 实机或真实付费服务验收 |
| 真实模型 | Windows 新增 10 次 Go / DeepSeek V4.1 Flash max 请求，开源源码修复独立检查 45/45，A/B/A 冷恢复及请求隔离通过；[本轮验收](verification/preset-real-agent-2026-10-29.md)。历史最小命令链及 Mac 代码任务仍见 [Windows 记录](verification/windows-2026-10-28.md)、[代码任务](workflow-agent-real-code-acceptance.md) |
| 研究服务 | 内置 Tavily 路径及 HTTP MCP 已实现；Exa 曾有真实来源链验证，Tavily 真实账号/研究质量仍待验收 |

自动、模拟模型、真实系统隔离、付费模型任务和用户接受是不同证据。Windows alpha 暂不支持隔离 stdio MCP，普通权限拒绝启动，不自动改为 full；网络过滤仍保留已记录的匿名令牌 loopback 边界。

## 下一步

- 先修复本机 Windows 原生初始化的锁文件拒绝访问，重跑真实隔离验收；详见批次 1 记录。
- 补完整 Windows 回归；既有全量在旧 30 秒用例预算处失败并中断，不能以定向通过代替全量；大历史与长期行为另验。Mac 本轮新管理/交接与新目录准备见上述独立记录。
- Windows 本地 MCP 隔离能力修复、其余硬件架构验收。
- 六项真实任务的用户试用、Tavily 与长期/断网/限流验证，见 [任务验收](workflow-agent-acceptance.md)。
- GUI、独立安装包和升级迁移另行处理。

原 2026-10-15 的迁移、MCP、基本命令和交付数字属于历史轮次，不再作为当前待办或全量总数。原始证据分别见 [迁移](workflow-agent-migration.md)、[MCP](workflow-agent-mcp.md) 和对应 verification 文件；当前范围以本页和 HANDOFF 为准。
