# 第一阶段：基本命令与文件撤销

> 执行方式：在当前已授权的工作目录内逐项执行，沿用 executing-plans、test-driven-development 和 verification-before-completion；不创建提交或分支。

**目标：** 补齐可发现、可操作的基本 TUI 命令，提供 `/retry` 的同义词 `/redo`，以及用户确认的“撤销上一轮文件工具修改”。

**设计依据：** `docs/workflow-agent-command-assessment.md` 和本轮用户决定。范围限第一阶段，不扩展预设、GUI、插件加载或模型切换。

**实现方式：** 由同一份产品命令表生成帮助和补全，并在已有扩展输入事件中检查参数、调用 OMP 会话能力。撤销复用 `ChangeJournal.restoreMany` 和现有批准机制；不另建 Git 快照系统。

**环境：** Bun 1.3.14，TypeScript，OMP SDK，既有 Bun 测试与 oxlint/oxfmt/tsgo。

## 任务与验收

- [x] 1. 命令入口、帮助和补全。
  - 修改 `src/tui/extension.ts`，新增 `src/tui/commands.ts`；使用 `AgentSession` 的 context、effort、retry、fresh、stats 能力。
  - 开放 `/help`、`/context`、`/effort`、`/retry`、`/redo`、`/fresh`、`/usage`、`/tools`、`/jobs`、`/todo`、`/mcp`、`/plan`；保留产品菜单和已有基本命令。
  - `/session` 仅显示信息；`/mcp` 仅走产品菜单；拒绝未支持的参数和原生命令。
  - 给原生 TUI 增加可选补全命令表，默认行为不变。`src/cli.ts` 传入产品命令表。
  - 测试先检查真实扩展输入不会调用模型、不会泄露原生入口；再检查实际补全候选。
- [x] 2. `/retry` 与 `/redo`。
  - 使用相同的 `session.retry()`，拒绝附加参数或运行中的重试。
  - 本地 HTTP 模型先失败、再恢复，在原会话重试成功且保留原用户消息；两种拼写都覆盖。
- [x] 3. `/undo` 和恢复菜单共用保护。
  - 新增 `src/changes/undo.ts`，选择最近一轮未恢复记录，展示文件列表及差异，批准后批量恢复。
  - 复用路径限制、计划模式检查和批准；队列等待后再次检查模式及空闲状态。后台任务仍运行时拒绝恢复。
  - 每个文件写入前检查当前内容。冲突发生在预检时，所有文件保持原状；执行期间失败须说明哪些已恢复。
  - 聊天不回退；通过静态 `src/prompts/files-undone.md` 告知模型重新读取文件，且不自动请求模型。
  - 真实文件测试覆盖多文件、同文件多次修改、新文件删除、已有用户修改保留、恢复后的重启、冲突、拒绝、计划模式及排队期间切换模式。
- [x] 4. 验证、复查与文档。
  - 运行产品全部测试、oxlint、oxfmt、tsgo；运行相关原生补全与重试测试；真实 macOS 沙箱测试另行执行。
  - 自查权限、忙碌状态、保留聊天、部分恢复提示和默认 OMP 行为。
  - 更新产品 README、命令评估及 CHANGELOG，记录实际结果和未验证边界。

## 复用调查

- [pi-rewind](https://github.com/arpagon/pi-rewind)：参考按轮选择、恢复前预览和只恢复文件的交互。它依赖 Git 快照和 Pi 扩展接口；本产品已有支持非 Git 工作区的文件记录，不引入第二套引擎。
- [OpenCode revert](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/revert.ts)：参考空闲检查和文件恢复边界。它依赖 OpenCode 自身的快照与会话服务，不能直接作为本项目模块使用。

## 风险和回退

撤销覆盖直接 `write`、`edit` 等已经记入日志的文本修改，不能回滚 bash、Git、MCP、外部服务和未记录文件；同名文件被用户继续编辑时拒绝覆盖。多文件恢复不是文件系统事务，执行期间的磁盘错误可能导致部分完成，保留恢复备份与逐项状态。补全限制只负责显示，执行限制仍由输入事件负责。改动均为可审查源文件，保留现有工作，不自动提交或安装。
