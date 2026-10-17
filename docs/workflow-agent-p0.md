# 第一阶段 P0：授权、原生搜索与长任务

更新：2026-10-17。适用本地 OMP 18.10.3 产品入口；第一阶段仍需真实服务和六项任务验收。

## 复用范围

- 会话、重试、摘要压缩、用量、终端界面和文件编辑继续使用 OMP。
- 文件查找和内容匹配调用 OMP 的原生 glob/grep 引擎；产品层只负责读取范围、结果分页和不完整提示，不再使用旧的 500 文件字面搜索。
- Git 命令的语法判断复用 OMP 严格 shell 解析器；新增可选单命令解析，原生命令链的默认行为不变。
- 自动审核复用 OMP 模型客户端和判断接口；只补授权问题、严格结果校验和用量统计。
- 本轮保留现有后台命令管理和资料获取路径，未扩大到后台系统或网页/PDF 解析器重写。完整工作流预设及 GUI 不属于本轮。

## 授权方式

在 TUI 输入以下命令，或使用 /agent → 切换授权方式：

~~~text
/permissions manual
/permissions auto
/permissions full
~~~

也可在启动时选择：

~~~sh
bun run agent --permissions auto --cwd /你的项目目录
bun run agent --permissions full --cwd /你的项目目录
~~~

| 模式 | 行为 |
|---|---|
| manual | 默认模式。允许范围内的读取及已启用的资料联网不逐项提问；文件写入、命令和 MCP 副作用需要批准。 |
| auto | 保留沙箱和目录/网络限制；普通直接文本修改自动通过。命令、MCP 和网络请求使用独立模型审核，潜在高风险、未知或审核失败时由人决定。 |
| full | 本次进程不逐项审批，命令不使用沙箱，可访问工作区外文件和网络，命令继承宿主环境。仍保留工具参数、文本大小、超时、取消及修改记录约束。 |

计划模式独立于授权方式：即使 full，也禁止计划模式下的文件写入、命令和 MCP 操作。切换授权前须停止运行及排队工作和托管后台任务；切换会断开 MCP，并清空旧批准。

full 只能由人通过当前启动参数或菜单/命令选择。配置文件只允许 permissions.approval 为 manual 或 auto；不允许保存 full。恢复命令不附带 full，旧会话也不会把它恢复回来。模型不能通过产品工具切换授权模式。

auto 会增加模型请求，/usage 的 automaticReview 显示额外请求、token 和估算费用。审核不加载工作流资源或提供行动工具，只有完整已知标签才会被接受；异常回答不会因为包含 allow 一词而获得许可。它不是确定性的安全证明，未知脚本、凭据传送、删除/历史改写、发布及持久安全设置仍需核对。

非交互 --print 没有人工批准窗口：默认拒绝需人工批准的动作。显式 auto 可完成低风险动作，需人决定时仍拒绝；full 则按本次明确授权执行。

## 开发环境

在现有 config.json 中合并所需字段，重启应用：

~~~json
{
  "permissions": {
    "approval": "auto",
    "readRoots": ["/absolute/toolchains", "/absolute/build-output"],
    "writeRoots": ["/absolute/build-output"],
    "allowNetwork": true
  },
  "execution": {
    "envNames": ["JAVA_HOME", "CARGO_HOME"]
  },
  "sandbox": {
    "required": true,
    "allowedDomains": ["registry.npmjs.org"]
  }
}
~~~

目录必须实际存在。模型和命令的目录范围分别经过产品检查与系统沙箱；只选择所需工具链、输出目录、变量名和域名。配置不保存变量值。包管理器若还访问其他域名，需要把实际需要的域名加进去。

普通 bash 不得写 .git。模型可对一条普通 Git 命令设置 gitWrite: true，经过批准后才获得该次元数据写权限；拒绝换行、多命令、重定向和命令替换。auto 对 Git 写请求仍询问人。此范围可用于暂存等操作，沙箱继续保护 hooks/config；仓库初始化、配置或 hook 修改需在外部手动处理，或由人明确选择 full。批准 Git 命令不能证明现有 hook 安全。

## 搜索与长文

grep 的 pattern 默认是正则；literal: true 改为字面文本。glob 筛选文件路径，gitignore 默认启用，hidden 控制隐藏文件。find 使用文件名 glob；返回 complete、truncated、skipped 和 nextOffset，可按 offset 继续。跳过文件、到达限制或缩短行内容时不能据此断言不存在。搜索排除 .git、node_modules 和产品缓存目录；需要检查其中的具体文件时使用 read 或经授权的命令。

read_document 和 web_fetch 返回来源 ID、正文片段、range 和 coverage。首次正文最多 12,000 个 UTF-16 字符，按 range.nextOffset 继续；对 PDF 指定 page，按页内位置读取。示例工具参数：

~~~json
{"sourceId":"S1","offset":12001,"limit":4000}
~~~

上例用于 read_source；search_source 接受 sourceId、query，可选 page、offset、limit 和 ignoreCase。它检索已存正文并返回位置及片段，随后可继续读取。coverage 说明抓取和提取限制；range 说明本次返回的部分。来源 read 表示取得过正文，不表示模型读完原文件。

抓取上限为 5 MB；提取最多 2,000,000 个 UTF-16 字符，PDF 最多 200 页、每页 100,000 字符，并受总提取上限约束。未提取页、原文截断和扫描 PDF 不会冒充完整正文；未做 OCR。

## 记录、恢复和存储

修改记录与研究来源使用 Bun 自带 SQLite；快照和正文去重并按需查询。旧 changes.json、sources.json 成功导入后仍保留原件；原来源 ID 和已引用版本保持稳定。

累计超过 100 条修改或 200 项来源不会再阻止继续工作。常用修改列表显示最近 100 条，来源列表显示最近 50 项；/undo 仍选择最新运行的完整记录，报告可引用热列表以外的旧来源。/session 显示存储统计。本轮不自动删除证据，长期使用仍会占用磁盘。

/undo 继续只恢复直接文件工具的修改；人工编辑冲突时拒绝覆盖，命令/Git/MCP 不统一回滚。一次撤销超过 100 个文件，以及中途只恢复部分文件时，给模型的通知按实际结果生成。

## 验证和剩余验收

~~~sh
bun run --cwd packages/workflow-agent check
bun test packages/workflow-agent/test
MY_AGENT_SANDBOX_TEST=1 bun test packages/workflow-agent/test/sandbox.test.ts
~~~

真实沙箱检查需运行在允许调用 macOS sandbox-exec 的终端；使用临时项目、本机模型和 MCP 假服务，不需要真实密钥。额外权限只用于跨过开发宿主的外层隔离，产品自身沙箱保持启用。

真实 OpenCode Go / DeepSeek、Tavily 或选定 MCP 的完整任务，及此前读取成功后模型停顿的复测，仍按 [六项验收](workflow-agent-acceptance.md) 和 [停顿调查](workflow-agent-read-stall.md) 执行。离线测试不能代替这些验收。
