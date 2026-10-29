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
| 预设启动、管理与隔离 | 已实现草稿编辑/资源选择/复制、检查与默认绑定，保持独立历史和冷恢复；[使用方式](workflow-agent-presets.md)、[批次 2 证据](verification/batch2-preset-management-2026-10-29.md) |
| 真实模型 | 已有 OpenCode Go / DeepSeek V4.1 Flash max 最小命令链和辅助式代码任务；[Windows 记录](verification/windows-2026-10-28.md)、[代码任务](workflow-agent-real-code-acceptance.md) |
| 研究服务 | 内置 Tavily 路径及 HTTP MCP 已实现；Exa 曾有真实来源链验证，Tavily 真实账号/研究质量仍待验收 |

自动、模拟模型、真实系统隔离、付费模型任务和用户接受是不同证据。Windows alpha 暂不支持隔离 stdio MCP，普通权限拒绝启动，不自动改为 full；网络过滤仍保留已记录的匿名令牌 loopback 边界。

## 下一步

- 先修复本机 Windows 原生初始化的锁文件拒绝访问，重跑真实隔离验收；详见批次 1 记录。
- 批次 3：空闲进程交接、清理与失败回退；本批预设编辑界面的 Mac 实机复验另行补齐。
- Windows 本地 MCP 隔离能力修复；Mac 新准备参数的真实新目录复验、其余硬件架构验收。
- 六项真实任务的用户试用、Tavily 与长期/断网/限流验证，见 [任务验收](workflow-agent-acceptance.md)。
- GUI、独立安装包和升级迁移另行处理。

原 2026-10-15 的迁移、MCP、基本命令和交付数字属于历史轮次，不再作为当前待办或全量总数。原始证据分别见 [迁移](workflow-agent-migration.md)、[MCP](workflow-agent-mcp.md) 和对应 verification 文件；当前范围以本页和 HANDOFF 为准。
