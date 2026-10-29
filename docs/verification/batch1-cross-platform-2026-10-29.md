# 批次 1：Windows 回归、源码准备与文档收尾

日期：2026-10-29，Windows x64 / Bun 1.3.14 / OMP 18.10.3。基线 `6ba28a5241`，本轮补丁未提交、未推送。模型请求使用本机模拟服务，未读取真实密钥或发起付费调用。

当前判定：文件、摘要、队列和所选真实宿主回归通过，全新 Windows 源码/空缓存的完整依赖 prepare 首次通过；原生 Windows 隔离初始化失败，批次 1 尚未完全闭合。Mac 的已有证据保留，本轮准备参数未在真实 Mac 新目录复验。

## 变更与原因

- prepare 显式指定官方 npm registry，下载并发为 8；保留 frozen lockfile、ignore-scripts、可选依赖和原生组件校验，不修改锁文件或版本。
- `test/helpers.ts` 集中 Windows 宿主预算：每用例 240 秒，启动标记最多轮询 9000 次、间隔 10 毫秒；其它平台采用 30 秒/200 次（原预设测试中两项为 20 秒）。格式器因此重排部分调用，业务断言保留。
- journal 的 105 次修改/重开/撤销保留 30 秒预算；POSIX mode 断言仅用于 POSIX。越界夹具使用 Windows junction / POSIX 目录 symlink，继续验证越界写入及父目录被替换时拒绝恢复。
- HANDOFF 合并重复交接，使用文档区分当前状态与历史结果；完成计划归档，迁移待办改为当前交付入口，保留原始验收数字和用户接受状态。

## 宿主超时定位

旧用例在 30 秒终止时尚未向本机模型服务发送请求。独立加载完整宿主并完成一次模拟问答为 45.9 秒，再跑为 47.5 秒；加载跟踪约 1975 个源码模块、44 秒，后续用例首个子进程约 46–53 秒。部分用例启动 2–3 个独立宿主，原 2 秒就绪轮询也不足。

本轮调整测试等待预算，没有优化 SDK 冷加载，也未修改模型、MCP 请求超时或产品权限。不能把新的通过结果解释成启动性能已改善。

## 已通过的 Windows 检查

| 分组 | 结果 | 范围 |
| --- | --- | --- |
| 文件/审批/撤销、命令展示、摘要与队列 | 99 pass / 0 fail，294 断言，8 文件 | BOM/CRLF、版本审批、持久撤销、共享命令结果、压缩失败队列、队列归属与短摘要失败 |
| 宿主请求、授权撤回和编辑恢复 | 3 pass / 0 fail，27 断言 | 实际 SDK 请求、未选资源不注入、编辑后冷恢复撤销 |
| 会话占用与失败清理 | 2 pass / 0 fail，12 断言 | 初始化失败释放租约，活跃占用拒绝，释放后可恢复 |
| A→B→恢复 A | 1 pass / 0 fail，56 断言 | 实际模型/HTTP MCP 请求、凭据、聊天及撤销隔离 |
| MCP 来源冷恢复 | 1 pass / 0 fail，12 断言 | 导入宿主捕获结果，恢复后引用仍有效 |

文件/队列组命令：

```sh
bun --no-env-file test packages/coding-agent/test/write-line-endings.test.ts packages/workflow-agent/test/file-approval.test.ts packages/workflow-agent/test/journal.test.ts packages/workflow-agent/test/command-result.test.ts packages/workflow-agent/test/operation-preview.test.ts packages/coding-agent/test/compaction-flush-failure-keeps-queue.test.ts packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts packages/agent/test/compaction-short-summary.test.ts
```

宿主组分别从 `host.test.ts`、`preset-host.test.ts`、`source-import-host.test.ts` 按上表用例筛选运行。本轮没有运行 Windows 完整产品测试，不把跳过项或旧 Mac 全量结果合并为总数。journal 单独 12 pass、队列单独 57 pass 与上表重叠。

当前产品 check（oxlint、oxfmt、tsgo）全部通过。未提升时新目录的 `.bin/*.exe` 与 `srt-win.exe` 可出现 `0xC0000142` DLL 初始化失败，提升后版本、状态和 check 正常，没有因此改写检查入口。

## Windows 真实隔离：当前失败

进程/隔离组合为 **7 pass / 1 skip / 1 fail**，31 断言：PowerShell Unicode/参数/非零退出、进程树取消与超时、保留路径拒绝、显式 full MCP 清理及共享初始化取消等通过。真实隔离在初始化阶段失败，不能声称文件及网络隔离已重新验收。

```text
WindowsSandboxError: acl_grant_failed
open init-lock file C:\Users\Administrator\AppData\Local\sandbox-runtime\.acl-init.lock:
拒绝访问。 (os error 5)
```

- 独立运行隔离用例同样失败，排除生命周期 mock 污染。
- 直接原生 `srt-win.exe acl recover` 失败；用户在平常使用的管理员 PowerShell 复现同一错误。因此不能只归因于 Codex 外层限制。
- 最终完整安装的新副本也复现同一错误：隔离文件 2 pass / 1 skip / 1 fail，9 断言，失败仍在初始化打开同一锁文件；不是旧验证工具目录的依赖缓存问题。
- 文件的 .NET ReadWrite、独占打开及 OpenOrCreate 探针成功。固定 v0.0.81 源码表明错误在打开文件阶段、早于 LockFileEx。原因尚未确定，不能直接断定文件占用或 ACL 数据损坏。
- 有限探针只临时移走该锁文件，原生工具仍无法创建/打开新锁，随后恢复原文件；未修改 ACL 状态库、重置权限或卸载沙箱。
- user status 可查询，系统安装存在；已安装与当前初始化可用是不同状态。产品继续拒绝执行，不自动转为 full。

10-28 的隔离通过记录保留为历史证据。下一关是定位并修复原生初始化，再重跑工作区写入、受保护路径、越界写入、Git 元数据及网络拒绝；通过前不标记隔离重新验收完成。

## 独立源码准备

副本从基线 git archive 提取，仅覆盖本轮准备脚本；不复制真实配置、密钥、现有 node_modules 或原生组件。直接放在 `E:/myagent/` 下，避免继承 `.verification-tools/node_modules`。指定官方 registry 解决了默认解析报版本不存在、但官方元数据包含精确版本的问题。

`.batch1-clean-2026-10-29` 完成最终参数 prepare、原生 18.10.3 校验、离线问答及 check；它经历失败安装与重试，不能当作空缓存首次成功证据。doctor 可输出配置/状态，隔离可用性仍受上节问题限制。

曾试验 `--omit optional`，随后恢复，此调整未保留。空缓存省略可选依赖的准备成功，恢复可选依赖时又发生解压/ENOENT 失败；这些探索结果不作为最终完整依赖的干净安装证据。

最终另建 `.batch1-complete-2026-10-29`，以最终参数、全新源码和目录内的空 Bun 缓存首次运行：**301 packages installed，940.28 秒，退出码 0**；工具视图生成、官方归档校验和原生版本 18.10.3 加载通过。安装曾长时间无进度输出，最后自行完成；拟停止验收进程的首次自动审批超时，重试时进程已结束，没有实际停止。此时间仅为当前机器这次测量，不是安装延迟承诺。

该最终副本随后使用独立 home/cwd 完成 setup、doctor、离线问答和原 check，全部退出 0；doctor 的依赖 errors/warnings 为空，模型/搜索 credentialAvailable 均为 false。doctor 只检查配置和依赖，不初始化隔离；它的成功与上节真实隔离失败并不矛盾。

随后在新进程中以 --resume 恢复这次离线会话，退出 0，并确认原 JSONL 同时包含首次与恢复后的两次测试输入，没有创建另一份会话替代原历史。

## 证据位置与剩余边界

本机日志在 `E:/myagent/.verification-tools/batch1-2026-10-29/`，不作为运行时依赖或发布文件：`focused-final.log`、`host-green.log`、`lease-green.log`、`preset-green.log`、`source-mcp-green.log`、`windows-final.log`、`isolation-standalone.log`、`prepare-preserve-optional.log`、`complete-first-prepare.log`、`complete-{setup,doctor,demo,resume,check,isolation}.log`、`fresh-check-elevated.log`、`product-check-final.log`、`types-reviewed-final.log`。

文档审查覆盖当前使用文档和本轮修改的历史记录：37 份文档、132 个本地链接，0 断链；git diff --check 通过。最终产品 check 通过，没有通过放宽类型或格式规则消除报错。

没有新的真实 Mac 冷准备、Windows arm64、队列新时序的人类终端接受或完整 Windows 产品全量结果。Tavily、长期/断网/限流及六项业务任务的用户接受继续独立保留。本批不进入预设编辑、运行中切换、GUI、独立分发或系统 ACL 重置。
