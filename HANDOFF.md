# My Agent 当前开发交接

更新：2026-10-29。产品入口为 `packages/workflow-agent`，版本 0.2.0；OMP 18.10.3 / Bun 1.3.14。当前主线保持单 agent，GUI 尚未接入。

## 当前基线与本轮范围

已提交基线 `6ba28a5241`。本轮开始时工作区干净，HEAD 与本地 origin/main 记录一致；历史文档的“未提交、未推送”只描述当时状态。本轮批次 1 补丁尚未提交、未推送。

用户要求先完成双端稳定性、Windows 新修复复验、旧宿主超时定位与源码准备，再全面清理文档；不进入预设编辑、运行中切换或 GUI。当前状态与使用入口见 [交付说明](docs/workflow-agent-delivery.md)，本轮命令、失败和剩余边界见 [批次 1 验证](docs/verification/batch1-cross-platform-2026-10-29.md)。

## 已完成的产品能力

- 编程与研究工具、SQLite 修改/来源记录、按轮撤销、模型管理、新建/恢复、差异审查、goal/BTW 与资源热开关。
- 墨线 TUI、草稿保持、菜单审批退让；停止时收回排队输入，避免取消后自动续发。
- 创建/覆盖/替换审批共用差异预览，绑定旧文件版本；命令前台/后台/停止共用状态、日志首尾和游标展示。
- 文件写入、审批和撤销保留 CRLF/LF 与 BOM；完整摘要不因可选短摘要失败丢弃；压缩队列按消息归属恢复，保留新输入和掉落技能。
- 命名预设启动、清单检查与资源/模型/MCP/聊天/撤销隔离；A→退出→B→退出→恢复 A 已有实际请求和 macOS 终端证据。
- macOS arm64 Seatbelt 与 Windows x64 原生命令入口。Windows 使用独立 0.0.81 alpha 依赖，Mac 保留 0.0.50；共享业务代码，平台适配集中在 Shell、进程和隔离后端。

## 已有验收记录

- [最新稳定性回移](docs/verification/upstream-stability-2026-10-28.md)：macOS 产品 359 pass / 16 skip；真实沙箱/终端专项另行 10 pass。不同分组有重叠，不累加为总数。
- [macOS 与预设验收](docs/verification/mac-preset-2026-10-28.md)：实际请求、A/B/A 冷恢复、审批拒绝/返回、命令展开与后台停止。
- [Windows 原验收](docs/verification/windows-2026-10-28.md)：真实命令隔离和最小 OpenCode Go / DeepSeek V4.1 Flash max 链路；第二轮模型约 272 秒，不代表延迟合格。
- [真实代码任务](docs/workflow-agent-real-code-acceptance.md)：辅助式完成小型开源修复，另做只读核验；不等同于用户整体接受。

历史定量证据保留在对应验收文件；本交接不再重复已完成批次的待办和逐轮保存状态。

## 仍须处理

1. 先定位本机原生 `.acl-init.lock` 拒绝访问：管理员终端的 `acl recover` 同样失败，尚未确定原因，真实隔离复验未通过。准备与剩余边界见本轮验证；Mac 新准备参数需在真实 macOS 新目录复验。
2. 预设编辑/复制、工作区绑定和全局默认；随后单独处理空闲时进程交接及失败恢复。
3. Windows 隔离 stdio MCP：当前启动前拒绝，使用 HTTP MCP；显式 full 可直接启动但没有隔离。alpha 的匿名令牌 loopback 边界保留。
4. 真实 Tavily、复杂研究任务、长期/断网/限流行为和六项任务的用户验收。已完成的模型连通和代码样例不再作为全新待办。
5. GUI 和独立分发待后续阶段；复用现有运行时、权限、会话和预设接口。

## 开发约束

不读取或复制 env.local 密钥；离线回归用 `bun --no-env-file`。源码更新后运行 `agent:prepare`，以 [产品 README](packages/workflow-agent/README.md) 为使用入口。新功能与 Git 提交/推送、系统安装、付费服务及人工接受分别记录，不用自动测试替代用户验收。
