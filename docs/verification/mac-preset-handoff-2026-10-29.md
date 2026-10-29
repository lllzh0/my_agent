# macOS 预设管理、终端交接与源码准备验收

日期：2026-10-29。macOS arm64，Bun 1.3.14，My Agent 0.2.0 / OMP 18.10.3。基线为 `58cce6f8e9` 加本批未提交测试修正；没有产品源码、依赖、锁文件或 Windows 隔离改动。用户授权补齐 Mac 验收，本批没有提交或推送。

所有模型和 MCP 请求均使用受控 localhost 服务，主验收命令禁用环境文件并使用测试凭据，没有调用付费模型。测试配置、项目、历史与最终复验的会话租约目录均在临时目录；真实终端指实际 launcher/Ink/Bun PTY，不表示真实远端模型质量或人工接受。末轮辅助静态检查的一次参数漏项单独记录在第 5 节。

## 1. 默认临时目录的路径回归

默认 Mac 临时目录以 `/var/folders/...` 表示，真实路径为 `/private/var/folders/...`。两处测试夹具此前混用了两种表示，导致 supervisor 的目标清理保护和编辑器的相对资源选择失败。

仅在 `preset-management.test.ts`、`preset-handoff.test.ts` 的夹具创建处改用 `realpath(mkdtemp(...))`；没有放宽产品路径校验，保留 `home-alias` 符号链接用例，没有覆盖 TMPDIR。

```sh
bun --no-env-file test packages/workflow-agent/test/presets.test.ts packages/workflow-agent/test/preset-management.test.ts packages/workflow-agent/test/preset-handoff.test.ts
```

相同默认环境下，修复前 **30 pass / 7 fail / 165 次断言**，修复后 **37 pass / 0 fail / 198 次断言**。日志 `/tmp/mac-task1-default-{red,green}.log`。此前改用真实路径临时目录的对照实验只用于定位，不作为修复后的通过证据。

## 2. 实际 Mac 终端交接

沿用 `ink-acceptance.test.ts` 的真实 PTY 驱动，新增四项 Mac 用例；helper 透传底座已有的 `PI_TEST_SESSION_OWNERS_DIR`，让父子进程使用测试租约目录。没有加入产品测试钩子。

```sh
MY_AGENT_ACCEPTANCE_OUTPUT=/tmp/mac-task1-pty-captures bun --no-env-file test packages/workflow-agent/test/ink-acceptance.test.ts --test-name-pattern 'real Mac Ink'
```

首次定向为 **4 pass / 0 fail，65 次断言，19.03 秒**，日志 `/tmp/mac-task1-pty-final.log`；随后完整回归暴露并修正了本节末尾记录的输入同步竞态。修正后的完整 PTY 文件为 **6 pass / 1 skip / 0 fail，86 次断言，24.75 秒**（`/tmp/mac-task1-readiness-pty-file.log`），包含原有两条用例和新增四条；skip 另行开启系统沙箱验证。实际操作及文件/请求证据：

| 场景 | 观察与断言 |
| --- | --- |
| 编辑与默认绑定 | 取消新草稿不落盘；预览仍不保存，明确确认后保存；取消已有修改保留原定义；绑定后当前仍 bare，下一次启动使用 edited；共享 config.json 字节不变 |
| 同窗口 A→B→恢复 A | A 主动从默认 coding 改为 review/max，再切 B coding，恢复 A 仍为原 ID 的 review/max/plan；请求规则、工具、历史和 SQLite 修改记录分别归属，聊天各一份 |
| 临时 full 不继承 | 恢复 A 为手动授权；临时切执行模式尝试写入工作区外的测试文件，工具拒绝“目标超出工作区或允许范围”，文件不存在；随后恢复计划模式，runtime 没有 full |
| 准备中取消 | 对旧目标 changes.sqlite 持有受控独占锁，确认目标进程已取得会话租约、正在初始化且未激活；Esc 返回源，源沿原 ID 回答，旧目标 transcript/manifest 字节不变 |
| 目标资源失败 | 删除目标所选测试指令文件后触发真实编译 ENOENT；源继续原 ID 回答，旧目标记录保留，无多余会话文件 |
| HTTP MCP 生命周期 | UI 批准前零请求；批准后收到 initialize、initialized、tools/list；切到 chat 就绪时已收到一次 DELETE，正常退出没有重复关闭 |

MCP 用例证明新界面就绪时已关闭连接，不独立测量 DELETE 与目标激活的精确先后时间。没有在真实 Mac 进程中注入源 teardown 或目标激活后的失败；这两类保留监督状态机单元用例的证据。

终端文字快照位于 `/tmp/mac-task1-pty-captures/`：`mac-preset-editor-bound.txt`、`mac-same-terminal-a-resumed.txt`、`mac-preparation-cancel-target-failure.txt`、`mac-mcp-closed-on-handoff.txt`。

开发期间的错误限于测试驱动：不受本机 fixture 支持的模型路由、模态关闭等待、父子测试租约目录不一致，以及 JSON-RPC 的 unknown 类型。均修正后重跑，没有将这些错误宣称为产品故障。最终受影响的十文件组合为 **66 pass / 1 skip / 0 fail，527 次断言，59.98 秒**；skip 为需显式开启的系统沙箱 PTY。日志 `/tmp/mac-task1-affected-final.log`，与上面分组重叠，不相加。

主控随后首次全量为 **395 pass / 16 skip / 1 fail，2215 次断言，54 个文件，310.25 秒**（`/tmp/mac-handoff-product-full-20261029.log`）。唯一失败为目标资源准备失败后的继续输入：测试把目标子进程先写到共享 stderr 的原始 ENOENT，配上前一次取消留下的提示，当成源已解除冻结；输入实际仍被准备期监听器消费。源码顺序确认源收到 failed IPC 后才在 finally 释放输入，随后显示自己的 `Error: ENOENT` 通知。修正限于测试等待该源通知，先输入、确认编辑器已显示准确标记，再按 Enter，并检查第四次实际请求中的用户内容。没有盲等、放大超时或改产品冻结规则；最终复验结果单独列出，首次失败保留。

## 3. 真实 Mac 系统沙箱与关闭

```sh
# cwd: packages/workflow-agent
MY_AGENT_SANDBOX_TEST=1 MY_AGENT_ACCEPTANCE_OUTPUT=/tmp/mac-handoff-final-captures-20261029 bun --no-env-file test test/sandbox.test.ts test/ink-acceptance.test.ts
```

测试等待修正后的最终轮为 **14 pass / 0 fail，158 次断言，2 个文件，37.11 秒**，日志 `/tmp/mac-handoff-sandbox-final-20261029.log`。此前一轮为14 pass / 157次断言 / 39.71秒，不混算。在允许调用系统沙箱的测试宿主中运行，产品 Seatbelt 保持开启。覆盖审批返回/拒绝、写入、Git 范围、资源读取撤销、MCP/后台进程清理、命令日志/停止，以及上节四个新增流程。文字快照在 `/tmp/mac-handoff-final-captures-20261029/`。

另外运行原生关闭回归：`interactive-mode-loop-teardown.test.ts` **2 pass / 6 次断言**，`interactive-mode-shutdown-store-failure.test.ts` **5 pass / 23 次断言**，均零失败；日志 `/tmp/mac-native-{teardown,shutdown}-20261029.log`。这些是自动行为检查，不是人为制造真实存储损坏。

## 4. 新源码、空缓存准备和冷恢复

从固定基线 `58cce6f8e9` 的 Git archive 创建 `/private/tmp/my-agent-mac-clean-20261029-f9unjie8/source`。初始没有 node_modules、原生二进制或用户状态；使用旁边的空 cache 作为 `BUN_INSTALL_CACHE_DIR`，运行实际 `bun --no-env-file run agent:prepare`。

最终官方 registry / network-concurrency8 参数首次准备 **退出 0，27.81 秒**；其中 **302 packages installed / 23.21 秒**。保留 frozen-lockfile、ignore-scripts、可选依赖；工具视图生成成功，官方原生组件版本 **18.10.3** 校验和加载成功。没有修改准备脚本、锁文件或版本，也没有复用旧 node_modules/native 组件。

随后使用独立 home/workspace、白名单环境及测试租约目录，从该副本运行：

| 步骤 | 结果与用时 |
| --- | --- |
| setup --defaults | exit0，1.08 秒 |
| doctor | exit0，0.95 秒；darwin/arm64，模型和搜索 credentialAvailable=false；Seatbelt0.0.50 依赖 errors/warnings 为空 |
| --demo --print --prompt | exit0，1.16 秒；离线模式 |
| 新进程 --demo --resume 原文件 --print --prompt | exit0，1.14 秒；一份原 JSONL 同时保留首次和恢复后的输入 |
| 产品 check | exit0，4.22 秒；lint、格式、类型检查通过 |

证据：同目录 `prepare.log`、`prepare-result.json`、`isolated-smoke-result.json` 和 `isolated-{setup,doctor,demo,resume,product-check}.{stdout,stderr}.log`。先前未显式指定测试租约目录的 smoke 只作为预检查，不与最终轮混算。doctor 成功只证明配置和依赖；真实系统隔离证据见上一节。

## 5. 最终全量与交付检查

在正常默认临时目录下、等待逻辑修正后的候选工作区执行：

```sh
# cwd: packages/workflow-agent
bun --no-env-file test test
bun --no-env-file run check
```

最终全量 **396 pass / 16 skip / 0 fail，2219 次断言，54 个文件，285.14 秒**，日志 `/tmp/mac-handoff-product-final-20261029.log`。16 个默认跳过项包含 Windows 平台与需显式开启的系统隔离专项；本轮 Mac 系统隔离已另行开启通过。前文首次全量失败、定向重复、PTY、原生关闭和沙箱分组均不与此数量相加。

产品 lint、格式和类型检查通过，最终禁加载环境文件复验日志为 `/tmp/mac-handoff-wording-check-noenv-20261029.log`。Task 1 独立审查及输入同步修正的定向复查通过；整批交付审查 Ready: Yes，无 Critical/Important。两项 Minor 文字精度建议已修正并复查通过：MCP 标题按“新界面就绪时已关闭”描述实际证据，Windows 冷恢复历史说明明确限定原记录，不与本轮 Mac 成果混淆。文字修正没有改变测试逻辑，因此只补静态检查，没有重复整套行为测试。最终范围为8文件、561行增删，未超过9文件/1400行预算，无产品/依赖/锁文件变更；5份文档31个本地链接无断链，diff检查及范围检查无警告。

末轮两处文字修正的辅助检查曾运行 `bun run --filter @my-agent/workflow-agent check`，遗漏 `--no-env-file`。仓库存在 `.env.local`，因此不把这次静态检查当作“禁加载环境文件”的证据；未检查文件内容，未输出凭据或发起模型请求。主控随后使用 `bun --no-env-file run check` 复验通过，日志 `/tmp/mac-handoff-wording-check-noenv-20261029.log`。功能验收、空缓存安装及最终全量的受控环境证据不依赖该辅助检查。

## 剩余边界

Windows `.acl-init.lock` 拒绝访问、完整 Windows 回归、Windows 隔离 stdio MCP 与匿名令牌 loopback 边界均未由本轮修复。真实远端模型/搜索/外部 MCP、不同账号、长期/断网/限流和用户人工接受仍未验收。GUI、分发、依赖升级、系统 ACL 与协作分支不在本批范围。
