# OMP 稳定性回移验收（2026-10-28—29）

> 本页保留当轮 macOS 结果；后续 Windows 回归、准备及当前隔离失败见 [批次 1 验证](batch1-cross-platform-2026-10-29.md)，不要将不同平台/分组数字累加。

范围来自用户确认的三项：文件格式与取消、可选短摘要失败隔离、压缩期间输入队列恢复。底座仍为 OMP 18.10.3，Bun 1.3.14；没有升级依赖或加入 GUI、其它推荐批次。

固定上游快照：`413d278a87a69b453efabf8d1fedb9940385e8c6`。起点为本地 `e1fea81ff1`。本轮测试使用 `bun --no-env-file` 和本地文件/模拟响应，没有访问真实模型或读取项目密钥。

## 1. 文件格式、取消与撤销

提交：`70d95e7c5d`，`fix: preserve file conventions across writes and undo`。

来源：`0ffd42c7146a f77456fe1d75 28cc26edb5b4 f4ab1de8ca2c f4a34dea8182 9f93dddf2f87`。复用最后一项的文件约定扫描及原生回归，按本地桥接接口适配；没有替换整个上游文件。

写入已有文本文件时保留第一处换行约定和 UTF-8 BOM（文件开头的编码标记），包括 CRLF（Windows 常见换行）；显式带 CR 的输入按原样处理。新文件、二进制探测结果和清空文件保持原语义。跨扫描块的长首行、扫描时取消、最终字节数、未完成格式化批次提示、编辑器桥接均有覆盖。

My Agent 在批准前准备最终内容，预览、内容哈希和实际写入使用相同文本，并重新检查格式转换后的 1 MB 上限。撤销记录解码保留 BOM；额外纳入 `changes/store.ts` 是因为实际测试发现 Bun 1.3.14 的 SQLite 字符串绑定在保存前去掉 BOM。最小复现中字符串绑定的 `hex(v)=6869`，字节绑定并 `CAST(? AS TEXT)` 后为 `EFBBBF6869`，普通 TEXT 查询能保留 BOM。因此只修正绑定，不改表结构或查询，也没有加入迁移。

修复前：原生 7 fail / 4 pass；产品新测试 3 fail。解码修复后，关闭并重开撤销数据库的测试仍失败，进一步定位了 SQLite 绑定问题。修复后相关命令为：

```sh
bun --no-env-file test packages/coding-agent/test/write-line-endings.test.ts packages/coding-agent/test/write-acp-fs.test.ts packages/coding-agent/test/write-read-selector-misfire.test.ts packages/coding-agent/test/write-shebang-chmod.test.ts packages/coding-agent/test/write-hashline-header.test.ts packages/coding-agent/test/write-read-projection.test.ts packages/coding-agent/test/tools/write-special-files.test.ts packages/coding-agent/test/tools/write-file-url-targets.test.ts packages/workflow-agent/test/file-approval.test.ts packages/workflow-agent/test/journal.test.ts
```

结果：**75 pass / 1 skip / 0 fail，176 次断言，10 个文件**。跳过项为平台上的 shebang 执行位适用性检查。产品和 coding-agent 的 lint、格式、类型检查均通过；`git diff --check` 通过。日志为 `/tmp/task1-complete-tests.log`、`/tmp/task1-product-check.log`、`/tmp/task1-native-check.log`。

独立任务审查通过，没有 Critical/Important 问题。最终整批审查再次确认结果提示依据格式化后的真实内容，现有代码正确；缺少“格式化器移除 BOM/CRLF 后不误报”的回归，作为一个非阻断测试加固项保留。

## 2. 可选短摘要失败隔离

提交：`8b47294e21`。来源：`649b095b95141bfda614f1bad082ad843090d32c`（[上游 PR #16942](https://github.com/can1357/oh-my-pi/pull/16942)，@Mouriya-Emma）。

完整历史摘要生成后，可选界面短摘要出现错误响应、抛出请求异常、空文本或纯空白时，保留完整摘要并省略短摘要。取消响应和调用方取消仍以 `AbortError` 结束整个操作。没有修改完整摘要路由、提示词或重试策略。

修复前新增测试 **2 pass / 7 fail**，修复后 **9 pass / 0 fail**。随后运行：

```sh
bun --no-env-file test packages/agent/test/*compaction*.test.ts
bun --no-env-file run --cwd packages/agent check
```

结果：**189 pass / 0 fail，740 次断言，15 个文件**；lint、格式、类型检查及 `git diff --check` 均通过。覆盖既有的原生/远程压缩、认证错误、边界、重试、预算与计量测试。日志为 `/tmp/task-2-compaction-regression.log`、`/tmp/task-2-agent-check.log`；新增测试使用注入完成响应和 HTTP 响应，不请求真实服务。

## 3. 压缩队列恢复

提交：`96af7dbb60`，审查补正 `d9e187fa60`。来源：`27ff9369b700 0e884e58320b 470fcb26c281 318144430141`；采用最后的消息对象归属方案，没有搬入中间的时间范围标记方案。

失败时只收回本次操作放入会话队列的消息及图片等附属消息，保留其它来源的队列；第一条输入已经进入会话时不重复发送，延迟进入、拒绝及技能掉落分别处理。保留本地输入提交限制、`$` 技能入口、循环与手动停止行为。

初始核心回归 **0 pass / 13 fail**，修复后 **13 pass / 0 fail**。独立审查继续发现两项输入丢失问题：没有后续失败时掉落的首条技能未恢复，异步恢复旧批次会覆盖期间新增的压缩输入。新增六项测试并扩充一项旧测试，得到 **12 pass / 7 fail**；补正后核心 **19 pass / 0 fail，48 次断言**。恢复原批次按对象身份去重，并保持较新输入顺序；掉落首技能单独恢复，不重放已经成功交付的后续消息。定向复查确认两项问题均已解决，没有新的阻断问题。

最终相关命令（仓库根目录）：

```sh
bun --no-env-file test \
  packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts \
  packages/coding-agent/test/skill-prompt-message.test.ts \
  packages/coding-agent/test/input-controller-skill-queue.test.ts \
  packages/coding-agent/test/agent-session-skill-image.test.ts \
  packages/coding-agent/test/compaction-flush-failure-keeps-queue.test.ts \
  packages/coding-agent/test/agent-session-compaction-cancellation.test.ts \
  packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts \
  packages/coding-agent/test/agent-session-skill-keywords.test.ts \
  packages/coding-agent/test/input-controller-compaction-image.test.ts \
  packages/coding-agent/test/issue-825-repro.test.ts \
  packages/coding-agent/test/compaction-flush-loop.test.ts \
  packages/coding-agent/test/agent-session-queued-policy.test.ts

bun --no-env-file test \
  packages/coding-agent/test/agent-session-prompt-dispatch-race.test.ts \
  packages/coding-agent/test/agent-session-prompt-abort-race.test.ts \
  packages/coding-agent/test/input-controller-orphan-submit.test.ts \
  packages/coding-agent/test/agent-session-extension-command-admission.test.ts \
  packages/coding-agent/test/input-controller-followup-image.test.ts \
  packages/coding-agent/test/input-controller-followup-paste-expansion.test.ts \
  packages/coding-agent/test/interactive-mode-optimistic-skill-reconcile.test.ts \
  packages/coding-agent/test/compaction-flush-failure-keeps-queue.test.ts

bun --no-env-file run --cwd packages/coding-agent check
```

两组分别为 **209 pass / 0 fail，818 次断言，12 个文件**，**52 pass / 0 fail，177 次断言，8 个文件**。核心 19 项重叠，合计去重为 **242 项、19 个文件**。SDK lint、3285 文件格式检查、类型检查和 diff 检查通过。日志为 `/tmp/task3-fix-round1-{red,green,targeted,submission,check}.log`。

实施曾被代理服务容量及额度中断；保留了改动和失败日志，换可用代理续接，没有丢弃或重新生成已完成代码。三项技能元数据测试的错误回调预期和一处测试类型推断在提交前已修正，后续完整相关分组均通过。

## 4. 整体验收与审查

最终代码为 `d9e187fa60`，包含本批四个代码提交 `70d95e7c5d 8b47294e21 96af7dbb60 d9e187fa60`。最终产品验收（产品包目录）：

```sh
bun --no-env-file test test
bun --no-env-file run check
```

结果：**359 pass / 16 skip / 0 fail，1967 次断言，52 个文件，243.26 秒**；产品 lint、格式、类型检查通过。日志为 `/tmp/upstream-123-product-final.log`、`/tmp/upstream-123-product-final-check.log`。默认跳过的真实 macOS 专项另行启用并通过，Windows 专项因本机平台跳过；各分组有重叠，不与本节总数直接相加。审查补正前同数量的预跑只作为基线，不代替本次最终结果。

三项任务及队列审查补正后，独立最终审查完整读取 21 个代码、测试和 changelog 文件，并针对审批写入、SQLite 兼容、摘要取消和队列调用方做定点检查。结论为 **Ready: Yes，0 Critical / 0 Important**。唯一 Minor 是上文记录的格式化器结果提示回归缺口，没有已证实的生产故障；不扩充为格式化器改造。

真实 macOS 沙箱和终端验收（产品包目录）：

```sh
MY_AGENT_SANDBOX_TEST=1 bun --no-env-file test test/sandbox.test.ts test/ink-acceptance.test.ts
```

结果：**10 pass / 0 fail，92 次断言，2 个文件，18.06 秒**，日志 `/tmp/upstream-123-mac-sandbox-ink.log`。运行于 `96af7dbb60`，后续 `d9e187fa60` 只补正原生队列 UI helper 和对应测试，没有修改这些产品链路。外层开发环境限制了系统沙箱调用，因此该命令在提升后的测试宿主运行；产品自身沙箱保持开启。覆盖审批详情返回/拒绝、创建/覆盖/长片段差异、A/B/A 预设恢复、技能入口、Git 范围、资源读取撤销、MCP/后台进程回收、非零退出和日志展开。全部使用临时状态目录及本机模拟模型，没有真实模型费用。

产品、coding-agent 和 agent 的 lint、格式及类型检查均通过。代码范围为 21 文件、1670 行增删；包含四份交付文档的最终范围为 **25 文件、1885 行增删**，在预设的 30 文件、2500 行预算内，无依赖清单、锁文件或环境文件改动，范围检查无警告。

## 尚未验证的边界

本机为 macOS arm64。Windows 实机、真实编辑器格式化、真实模型服务、新队列时序问题的人工终端复现和人工整体验收没有在本轮执行。已经丢失 BOM 的历史撤销快照无法凭空补回原始字节，本次不会猜测修复旧记录。测试通过不等于用户人工验收，也不代表已推送、发布或部署。
