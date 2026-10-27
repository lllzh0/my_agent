# 真实开源代码任务验收

执行时间：2026-10-27 至 2026-10-28，Asia/Shanghai。

## 结论

My Agent 已使用真实模型完成一次小型开源代码修复：读取源码、通过手动审批运行复现命令、修改两个文件、补回归测试、运行完整项目检查并汇报结果。独立复核通过。另一个只读问题正确报告本地未复现，没有额外修改源码。

这次是有明确范围和验收条件的辅助式测试，不是一次无提示通过的能力评分：首轮只提供了 Unicode 报错例子，模型提出直接取消连字符转义；补充原 issue 中的字符集合要求后，它自行改为兼容的转义方案。没有向模型提供上游补丁，也没有替它编辑被测源码。

产品的菜单停止修复已先提交为 `ab1cea0147 fix(workflow-agent): restore queued input when stopping from palette`。本次测试随后运行于该版本，没有修改产品代码。本文、交接与机器可读记录补充保存这次测试的证据，不代表人工整体验收。

## 项目和任务来源

项目：[sindresorhus/escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp)，MIT 许可。下载完整仓库后，在独立临时目录检出修复前提交 `5085b257c801507460270b747f645276fbc1d937`，版本 2.0.0。

1. [Issue #20：Hyphens in Unicode mode](https://github.com/sindresorhus/escape-string-regexp/issues/20)，对应 [PR #21](https://github.com/sindresorhus/escape-string-regexp/pull/21)。要求修复连字符用于 Unicode 正则时的报错，同时保留字符集合内的字面含义。例：`a-z` 放进字符集合后只能匹配 `a`、`-`、`z`，不能匹配 `m`。
2. [Issue #41：单独加号转义问题](https://github.com/sindresorhus/escape-string-regexp/issues/41)。只读检查本地 `+` 和 `a+b` 在普通/Unicode 正则中的转义和匹配行为。该 issue 的作者后来确认误判；没有把该结论预先告诉被测模型。

这里复测历史问题，不表示当前上游仍有这些故障。没有在 GitHub 发评论、提交 PR 或推送代码。

## 运行方式与人工介入

- 实际产品 launcher、墨线 TUI、macOS PTY（交互终端）和虚拟终端屏幕读取；没有使用 demo 或模拟模型。
- 模型：用户配置的 `opencode-go/deepseek-v4.1-flash`，由 `.env.local` 读取 `OPENCODE_API_KEY`。测试配置单次输出上限 4096 tokens；原用户配置不变。
- 独立配置目录，未加载技能；模型工具联网关闭，命令保留产品 macOS 沙箱，修改和命令均经真实手动审批界面逐项允许。
- 测试执行者准备依赖、解决历史工具链兼容问题、提交任务和一次验收条件补充、批准范围内操作、独立审查补丁及测试。源码和回归测试均由 My Agent 的模型通过编辑工具修改。
- 主动开启临时宿主的 `/trace on`，用于对照请求、工具结果和最终回答；未把原始正文日志加入产品仓库。

## 结果和证据

| 项目 | 实际结果 |
| --- | --- |
| 修复前复现 | `new RegExp(escapeStringRegexp('-'), 'u')` 抛 `SyntaxError: Invalid escape` |
| 源码修改 | 仅 `index.js`、`test.js`：28 行新增、3 行删除；将连字符单独转为 `\x2d`，其余特殊字符保持原处理 |
| 模型运行项目检查 | `CI=1 npm test` 退出 0：xo 代码检查、AVA 4 项测试、tsd 类型检查全部通过 |
| 独立重跑 | 2026-10-28 在最终文件上再次运行相同检查，退出 0，4 项测试通过 |
| 独立行为检查 | 修复前 30 通过、8 失败；修复后及次日重跑均为 **38 通过、0 失败** |
| 加号只读检查 | `+`、`a+b` 均按字面匹配，无标志和 `u` 下都不匹配 `aaab`；模型明确报告本地未复现 |
| 只读检查前后 | `index.js`、`test.js` 的 SHA-256 指纹均相同，未追加修改 |
| 退出 | 最终 `/quit` 正常退出，退出码 0 |

独立行为检查没有提供给模型，包含空字符串、连字符、其他正则特殊字符、中文/emoji、换行、字符集合中的范围误匹配，以及非字符串输入；不要求它复制某一种源码写法。原始项目测试只有 2 项，模型新增 2 项并更新旧连字符期望。

共捕获 13 次真实模型请求：10 次返回工具调用，3 次正常结束。作业记录有 7 条命令：最初 2 条被测试宿主的外层沙箱阻止，其余 5 条成功。中途没有批准的命令不计作成功执行。

## 环境问题和中断记录

这些情况没有被计入代码修复成功：

1. 历史工具链在机器默认 Node 24 下报 `util.isDate is not a function`；尝试用 Bun 执行也遇到旧 AVA/Bluebird 不兼容。改用下载并校验官方校验和的隔离 Node 20.20.2，并仅在临时 `node_modules` 中安装兼容的 `@types/node@12.12.6`、`@types/minimatch@3.0.3`，不改 `package.json`。兼容环境中，修复前的完整检查先通过。
2. 最初 My Agent 的两条命令报 `sandbox-exec: sandbox_apply: Operation not permitted`。在宿主层检查确认可启动 macOS 沙箱后，获得宿主执行权限重启测试驱动；仍保留产品手动审批和产品命令沙箱，没有切到 full 权限。
3. 测试驱动曾误将会话 ID 传给需要会话文件路径的启动参数；随后临时增加环境变量透传配置又触发恢复指纹不匹配。改用实际会话路径并保持原配置后恢复成功。这是测试驱动准备问题，没有修改产品恢复规则。
4. 10 月 27 日最后一条只读命令尚在等待审批时，外部自动审批服务因账户额度不足而失败，按键未执行。测试驱动随后触发时限退出。10 月 28 日恢复原会话，重新运行该只读命令并完成检查，没有把上次未执行的操作当作已完成。

## 可复查材料

结构化摘要：[real-code-acceptance-2026-10-28.json](verification/real-code-acceptance-2026-10-28.json)，包含请求 ID、命令结果、独立检查逐项结果和源码指纹。

本地测试目录：`/tmp/my-agent-code-acceptance-5XEg05`，其中：

- `project/`：保留下载的项目及模型修改；`agent.patch`：模型补丁。
- `04-fix-and-tests-passed.txt`：模型完成修复及测试后的真实终端屏幕。
- `05-plus-readonly-approval.txt`、`06-plus-readonly-complete.txt`：只读核验的审批和回答。
- `compatible-baseline-tests.log`、`final-project-tests-2026-10-28.log`：修复前兼容环境和最终检查日志。
- `acceptance.cjs`、`oracle-before.json`、`final-oracle-2026-10-28.json`：独立检查及前后结果。
- `agent-home/`：测试会话、模型请求轨迹、命令记录；`audit.json`：凭据精确值检查结果。

对 51 个测试输出、状态 JSON、会话 JSONL、产品日志及相关源码/配置清单检查实际模型和搜索密钥，0 命中。检查范围不含依赖目录和下载的运行时。临时文件可能被系统清理，结构化摘要保留在产品仓库中。

## 结论的适用范围

这次证据支持：在小型 JavaScript 项目、明确任务范围、兼容运行环境和必要澄清下，My Agent 能完成真实代码修复并通过独立验证。不能外推到大仓库、复杂跨文件任务、其他模型/系统或无人值守运行；不据此宣布产品第一阶段全部验收。

交互上仍有一个可改进点：编辑审批展示原始参数 JSON，命令结果默认折叠后主要显示作业元数据；完整信息可以展开，但日常验收不够直观。后续可优先把审批改成清晰的修改前后对比，并在命令完成时直接展示退出码和短结果。本轮只记录观察，没有追加界面改动。
