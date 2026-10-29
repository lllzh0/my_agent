# 命名工作流预设与管理

更新：2026-10-29。已提供创建/复制、终端草稿编辑、资源选择、默认绑定与终端内切换。未设置默认时，不带 --preset 仍为 legacy。Win/Mac 共用存储、编译、编辑器和交接逻辑；本轮新增交接只在 Windows 实机验证。

## 开始使用

先用旧入口配置好模型和 MCP，再创建清单：

```sh
bun run agent setup --defaults
bun run agent preset list
bun run agent preset create work --template coding
bun run agent preset create research --template research
bun run agent preset show work
bun run agent preset check work
bun run agent preset copy work work-lite
bun run agent preset bind work
bun run agent preset default work
bun run agent preset default
bun run agent --preset work
bun run agent --preset chat --demo
```

管理命令在轻量 launcher 中执行，不启动 SDK、模型或 MCP。`check` 只验证格式、路径和连接引用，不证明模型连通、技能元数据正确或沙箱可运行。当前运行平台包括已准备的 macOS arm64 与 Windows x64；Windows 命令隔离仍为 alpha，并有本地 stdio MCP 限制，见 [Windows 说明](workflow-agent-windows.md)。跨平台更新源码后需运行 `agent:prepare` 补齐基础依赖和生成资源；准备行为与平台证据见 [当前交付](workflow-agent-delivery.md)。

`chat` 为纯聊天；`bare` 含常用产品工具，但没有工作流指令、技能或 MCP。两者不可覆盖。`coding` 和 `research` 是创建模板，不自动选择本机 AGENTS 或技能。`research` 初始没有直接文件编辑、命令和 goal，可保存研究报告。创建不会覆盖同名目录或清单。

清单保存在 `<MY_AGENT_HOME>/presets/<ID>/preset.json`，日常可用下文菜单编辑；以下 JSON 仅说明格式，保存后下次启动生效：

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

## 不手改 JSON 的编辑方式

启动 `bun run agent --demo`，输入 `/preset` 或在 `/agent` 菜单选择“预设管理”。也可直接使用 `/preset edit work`、`/preset create 新ID`、`/preset copy work 新ID`。创建/复制的菜单入口先打开草稿，取消不产生清单；命令行 create/copy 是明确的立即创建操作。copy 与 clone 为同一操作。

编辑器可修改名称、模式、指令、技能、附加提示词、工具、模型连接、MCP 和权限。候选仅来自共享配置、当前草稿或用户主动添加的路径；技能目录先扫描，再逐个勾选具体 SKILL.md，新增候选默认不选。选择不向模型发送正文，不连接服务。工作区相对路径以 / 保存，便于两端复用；绝对路径仍属于相应机器。

保存前检查工具依赖：技能需要 read；bash 需要 job_output/job_stop；MCP 服务需要 mcp_list/mcp_call，没有服务时不能保留 MCP 工具。连接只保存 key/name，权限只保存 manual/auto 和目录/网络范围，不能持久化 full。

“检查草稿”不保存；“预览并保存”先检查引用、显示差异，返回后再确认。放弃编辑不写文件；其他编辑器改变了原定义时拒绝覆盖，需重新打开。保存不改变当前运行配置；资源、工具、模型或权限清单变化后，旧会话恢复仍要求原身份匹配，需新建会话或还原原清单。

复制仅创建定义：workspace 引用保持相对；preset 引用转换为原文件的绝对引用；不复制资源文件、历史、任务、凭据或临时授权。原文件被移走后检查会失败，不寻找同名替代文件。

## 工作区绑定与全局默认

```sh
bun run agent preset bind work
bun run agent preset unbind
bun run agent preset default work
bun run agent preset default --clear
bun run agent preset default
```

菜单提供同样操作；`/preset defaults` 查看磁盘默认。仅影响后续启动，`/new` 继续当前预设。绑定写在 `<home>/workspaces/<规范化cwd摘要>/preset.json`，全局默认写在 `<home>/preset-default.json`，不写项目文件。Windows 规范化大小写，两端都解析真实目录，目录链接不产生另一套绑定。全局文件不占用预设 ID 目录，避免与合法的 index.json 预设名冲突。

普通新启动优先级为显式 --preset、工作区绑定、全局默认、legacy。--light 保留旧轻量入口，不套用默认；与显式 --preset 冲突。setup/doctor/diagnose/restore-config 和帮助不自动套用默认。坏绑定、缺失预设或引用错误明确报错，不静默换成另一份清单。

未指定 --preset 的 --resume 按原会话所在受控目录确定预设，忽略新默认；显式选择另一预设不能绕过宿主身份检查。默认文件不是恢复授权，也不保存 full。菜单和设置只能由用户主动调用，模型发出的 /preset 管理命令会被拦截。

## 当前会话与恢复

`/preset` 打开管理菜单；`/preset use ID` 切换独立运行环境，有历史时明确选择新建或恢复；`/preset use ID --new` 明确新建。同 ID、定义和资源未变时不重复打开，改动后先展示快照并要求新建。准备时输入冻结，Esc 可取消；准备失败保留源会话，关闭/激活失败尝试恢复源记录。

切换前需停止或等待模型、排队输入、BTW、goal、review、模型/资源切换与后台任务完成。产品不为切换自动杀掉正在运行的工作。源保存并释放终端后才激活目标；full 和临时授权不传递，计划模式不会因切换解除。当前 Windows SDK 冷启动较慢，切换不是即时完成。

`/preset show` 显示当前身份及实际资源、工具、模型和 MCP，`/preset show ID` 查看磁盘定义及引用检查。F3 查看已生效资源，标题显示预设 ID。工具开关仍由执行层检查，关闭的工具不会因 goal 或旧句柄重新启用。

命名预设继续采用固定启动清单：F3 只提供状态查看，/preset edit 修改磁盘草稿，下次启动生效。资源热编辑、技能导入和共享 MCP 配置编辑不在命名预设中执行；可先在 legacy 管理服务/导入技能，再从编辑器选择。不带 --preset 且没有默认绑定的原入口继续支持资源热开关。

会话 JSONL 位于 `<MY_AGENT_HOME>/presets/<ID>/sessions/`，SDK 目录为 `omp/presets/<ID>/agent/`；任务、来源、撤销和轨迹仍按唯一会话 ID 保存。`/new` 保持当前预设；`/resume` 可显示当前工作区其他预设的标签，命名会话统一通过交接恢复，legacy 内部保留原进程内恢复。不匹配的清单/资源仍拒绝，不能把另一预设的文件强行按当前身份打开。已有记录不迁移、不删除。

命名会话在交接或正常关闭时把连接 key、思考强度和计划状态保存到可选的版本化 runtime 字段，恢复时重新读取凭据；未激活目标不写入启动/退出文本或运行选择。没有此字段的旧会话按原启动配置恢复，legacy 模型规则保留。恢复目标不自动续跑 goal。

退出时恢复命令自动保留 `--preset`。`--preset` 与 `--light` 冲突；原来的 `--light` 及旧会话恢复方式保持可用。显示名称变更不改变身份，资源或能力清单变更需要新会话或恢复原定义。

清单可保存 manual/auto、目录及网络范围，不能保存 full。用户仍可在当前进程主动选择 full；计划模式与现有授权检查继续独立生效。

交接、取消、失败回退和真实 Go / DeepSeek max A/B/A 记录见 [批次 3 验证](verification/batch3-terminal-handoff-2026-10-29.md)。完整 Windows 回归、新 Mac 实机及原生命令隔离仍有缺口；尚未实现可移植预设包或 GUI。

macOS 的实际请求隔离、A→B→A 冷恢复与终端 `$` 技能调用证据见 [Mac 历史验收](verification/mac-preset-2026-10-28.md)。Windows 新增真实 OpenCode Go / DeepSeek V4.1 Flash max 开源源码任务、默认绑定和 A/B/A 冷恢复，见 [10-29 真实验收](verification/preset-real-agent-2026-10-29.md)；没有新增 Mac、命令隔离或运行中交接的通过声明。
