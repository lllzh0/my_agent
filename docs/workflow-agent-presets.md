# 命名工作流预设：启动版

2026-10-28。当前提供命名清单、启动选择、引用检查、实际资源展示和独立会话归属；终端内跨预设切换、默认绑定和预设编辑器仍属后续批次。现有不带 `--preset` 的入口保持原行为，等同 `legacy`。

## 开始使用

先用旧入口配置好模型和 MCP，再创建清单：

```sh
bun run agent setup --defaults
bun run agent preset list
bun run agent preset create work --template coding
bun run agent preset create research --template research
bun run agent preset show work
bun run agent preset check work
bun run agent --preset work
bun run agent --preset chat --demo
```

管理命令在轻量 launcher 中执行，不启动 SDK、模型或 MCP。`check` 只验证格式、路径和连接引用，不证明模型连通、技能元数据正确或沙箱可运行。当前运行平台包括已准备的 macOS arm64 与 Windows x64；Windows 命令隔离仍为 alpha，并有本地 stdio MCP 限制，见 [Windows 说明](workflow-agent-windows.md)。跨平台更新源码后需运行 `agent:prepare` 补齐基础依赖和生成资源；准备行为与平台证据见 [当前交付](workflow-agent-delivery.md)。

`chat` 为纯聊天；`bare` 含常用产品工具，但没有工作流指令、技能或 MCP。两者不可覆盖。`coding` 和 `research` 是创建模板，不自动选择本机 AGENTS 或技能。`research` 初始没有直接文件编辑、命令和 goal，可保存研究报告。创建不会覆盖同名目录或清单。

定义在 `<MY_AGENT_HOME>/presets/<ID>/preset.json`。编辑文件后重新启动生效，例如：

```json
{
  "version": 1,
  "id": "research",
  "name": "资料研究",
  "mode": "agent",
  "model": { "default": "primary", "allowed": ["primary"] },
  "resources": {
    "instructions": [{ "base": "workspace", "path": "research.md" }],
    "skills": [{ "base": "absolute", "path": "/path/to/skill/SKILL.md" }],
    "appendSystem": []
  },
  "tools": ["read", "web_search", "web_fetch", "read_source", "search_source", "write_report", "ask_user"],
  "mcpServers": []
}
```

`primary` 必须对应共享 config.json 中的连接 key；未填写 model 时只使用当前默认连接。未选模型不进入候选；不复制密钥值。MCP 同样只引用已配置、已启用的名称，连接及业务调用继续经过现有批准。

路径基准支持 workspace、preset、absolute。前两者解析链接后不得超出相应根目录。技能逐个引用 SKILL.md，不引用会自动扩大扫描范围的目录。空数组明确表示不加载；不会叠加旧配置中的资源、附加提示词或 MCP。

## 当前会话与恢复

`/preset` 或 `/preset show` 显示当前身份及实际资源、工具、模型和 MCP；F3 查看已生效资源，标题显示预设 ID。工具开关仍由产品执行层检查，关闭的工具也不会因 goal 或旧工具句柄重新启用。

命名预设本批采用固定启动清单：F3 只提供状态查看，资源热编辑、技能导入和共享 MCP 配置编辑不在命名预设中执行。请在 legacy 中管理服务/导入技能，再把选中的具体文件或服务名写入清单。不带 `--preset` 的原入口继续支持现有资源热开关。

会话 JSONL 位于 `<MY_AGENT_HOME>/presets/<ID>/sessions/`，SDK 目录为 `omp/presets/<ID>/agent/`；任务、来源、撤销和轨迹仍按唯一会话 ID 保存。当前工作区的 `/new` 和 `/resume` 只操作当前预设的会话。跨预设文件或不匹配的清单/资源拒绝恢复；已有旧记录不迁移、不删除。

退出时恢复命令自动保留 `--preset`。`--preset` 与 `--light` 冲突；原来的 `--light` 及旧会话恢复方式保持可用。显示名称变更不改变身份，资源或能力清单变更需要新会话或恢复原定义。

清单可保存 manual/auto、目录及网络范围，不能保存 full。用户仍可在当前进程主动选择 full；计划模式与现有授权检查继续独立生效。

后续先实现清单编辑及默认绑定，再处理空闲时进程交接和失败回退；当前不能使用 `/preset use` 在运行中切换，也未实现可移植预设包或 GUI。

macOS 的实际请求隔离、A→B→A 冷恢复与终端 `$` 技能调用证据见 [本批验收](verification/mac-preset-2026-10-28.md)。本机模拟模型证明资源与协议行为，不代表远端模型任务质量或 Windows 本轮已复测。
