# macOS 回归与预设隔离验收

日期：2026-10-28，Asia/Shanghai。基线：main `5f2e5191f6`，macOS arm64、Bun 1.3.14。用户授权先恢复 Mac 可运行状态并验收命名预设隔离；本批没有扩展 GUI、预设编辑器或运行中切换。

## Mac 环境恢复

此前本机已有依赖来自 Windows 适配之前，缺少新锁定的 `@my-agent/windows-sandbox` 别名。Mac 启动也会加载包含该依赖的共享模块，因此类型检查、宿主测试及 TUI 启动一并报模块缺失。

按现有锁文件执行：

```sh
BUN_INSTALL_CACHE_DIR=/tmp/my-agent-mac-verify-cache bun install --frozen-lockfile --ignore-scripts --filter @my-agent/workflow-agent --filter @oh-my-pi/collab-web
```

安装 18 个包后，原模块缺失及相关类型报错消失，产品 `bun run check` 通过。`bun.lock`、依赖声明与产品源码均未修改；没有执行依赖安装脚本。Mac 命令继续使用原 0.0.50 Seatbelt 后端。这里证明已有 Mac 工作区的增量准备成功，不代表全新机器的完整准备流程已经验收。

原有产品全量回归：**350 pass / 15 skip / 0 fail，1861 次断言，50 个文件**。这是加入本批验收测试之前的基线结果；最终回归以本页收尾记录为准。

## 预设的实际请求与恢复

新增 `test/preset-host.test.ts`，复用现有 SDK 宿主、独立子进程和本机 HTTP 模型服务；不是只检查配置对象。三项测试 **3 pass / 0 fail，75 次断言**：

- A/B 分别选择不同的指令、技能、工具、模型连接凭据引用和 HTTP MCP。捕获实际出站消息、工具定义及请求头，确认只出现当前选择；共享配置、项目及父目录中的未选指令和技能标记不进入请求。
- 技能首先只广告名称与描述，正文没有预加载；模型用实际 read 工具读取所选 SKILL.md 后，正文进入后续请求。A 的 MCP 调用实际到达 A 服务，此时 B 服务保持零请求；B 同理。
- 执行 A→退出→B→退出→恢复 A。B 不含 A 的聊天、工具结果及撤销记录；恢复 A 后会话 ID、状态目录、聊天、技能正文、MCP 结果与撤销记录仍属 A，不含 B。
- 将 A 的会话文件交给 B 恢复时拒绝，模型请求数不增加，原 A 会话文件不变。
- chat 的实际请求没有工具及工作流资源；bare 有常用工具，没有共享配置中的工作流指令、MCP 或 chat 的聊天。
- 模拟模型伪造已关闭的 write，以及未选 MCP 的名称：均返回错误，没有文件写入、撤销记录或外部 MCP 请求。即使测试批准回调愿意允许，也不能绕过能力清单。

`helpers.ts`、`host-worker.ts` 仅增加 `preset?: string` 测试参数声明，运行仍走已有真实宿主路径。

## 真实终端与系统命令

新增 `test/ink-acceptance.test.ts`，通过实际产品 launcher、Bun PTY（真实交互终端）及 VirtualTerminal 读取屏幕。macOS 宿主提升后运行的三项专项 **3 pass / 0 fail，26 次断言**：

1. 创建审批→查看只读详情→返回→拒绝，期间文件始终不存在；随后明确允许创建和覆盖。覆盖显示旧新内容。长替换片段末尾的真实差异可见，Esc 拒绝后源文件保持原状。
2. 三次实际 launcher 启动完成 A→B→恢复 A；手动 `$preset-a` / `$preset-b` 通过原生输入控制器展开各自技能正文。捕获请求确认 B 无 A 内容、恢复 A 无 B 内容；A 前后会话请求头相同，B 不同；三次 `/quit` 均正常退出。
3. 手动批准的真实命令经产品 macOS 沙箱执行。折叠结果保留退出码 7 与尾部错误，Ctrl+O 展开后显示更多实际日志；启动后台 sleep 后通过 job_stop 停止，界面显示已取消，进程已退出。

现有 `test/sandbox.test.ts` 真实系统隔离专项 **7 pass / 0 fail，66 次断言**，覆盖自动审批上下文、Git 写入范围、外部工具链目录、受管技能开关、模型触发命令、stdio MCP 与后代进程清理、后台 shell 退出恢复。

```sh
MY_AGENT_SANDBOX_TEST=1 bun --no-env-file test test/sandbox.test.ts
MY_AGENT_SANDBOX_TEST=1 MY_AGENT_ACCEPTANCE_OUTPUT=/tmp/my-agent-mac-acceptance bun --no-env-file test test/ink-acceptance.test.ts
```

第一次在 Codex 默认外层沙箱内运行系统专项为 0 pass / 7 fail，错误指向 sandbox-exec 无法应用隔离，部分后续状态断言随之失败。提升的是测试宿主；被测产品仍走 manual / auto 及原 Seatbelt，未切到 full 或取消产品隔离。提升后上述 7 项和终端命令专项均通过，不把第一次失败记作成功。

预设测试第一版错误地把直接 SDK prompt 当成终端技能命令的分发入口，导致技能正文断言失败。修正测试路径：宿主测试验证模型按需 read；终端测试使用实际输入控制器验证 `$` 展开。没有因此修改产品技能行为，也没有将测试准备问题称作产品缺陷修复。

## 证据与边界

收尾结果：

| 检查 | 本轮结果 |
| --- | --- |
| 产品完整回归（含新增测试） | **355 pass / 16 skip / 0 fail**，1956 次断言，52 个文件，240.04 秒 |
| 产品 check | oxlint、oxfmt、tsgo 全部通过 |
| 实际请求专项 | 3 pass / 0 fail，75 次断言；已包含在全量结果中 |
| 真实终端专项（启用沙箱） | 3 pass / 0 fail，26 次断言；其中普通终端两项也包含在全量结果中，不重复累计 |
| 真实 macOS 隔离专项 | 7 pass / 0 fail，66 次断言；普通全量默认跳过，另行启用后通过 |
| 变更范围 | 仅测试与文档；没有产品源码、锁文件或依赖版本改动 |

全量的 16 项跳过来自 Windows 专项与显式启用的真实 macOS 沙箱/终端命令测试；不表示这些平台用例在默认命令中执行过。Windows 仍未在本机重跑。

本批全部模型响应来自本机受控 HTTP 服务，MCP 也使用本机服务；没有发送真实付费模型请求或读取用户真实密钥。系统沙箱和命令执行为真实 macOS 行为；终端操作由工具驱动，不代表用户人工接受。

本地日志：

- `/tmp/my-agent-mac-product-tests.log`：原有全量基线。
- `/tmp/my-agent-mac-product-final.log`：加入验收后的最终全量回归。
- `/tmp/my-agent-preset-host-tests.log`：实际请求专项。
- `/tmp/my-agent-mac-sandbox-tests.log`、`/tmp/my-agent-mac-sandbox-elevated.log`：外层受限失败与提升后结果。
- `/tmp/my-agent-ink-sandbox-acceptance.log`：真实终端专项。
- `/tmp/my-agent-mac-acceptance/`：审批详情、覆盖、长片段、日志折叠/展开、后台停止和预设恢复的文本屏幕快照。

临时日志和快照可能被系统清理；测试源码保留了可重复执行的验收步骤。没有修改个人配置或历史；旧 legacy 恢复由产品现有回归覆盖。Windows 本批未实机重跑，沿用其既有记录与限制。当前预设仍采用退出后重新启动，不宣称支持运行中切换、可视化编辑或默认绑定。
