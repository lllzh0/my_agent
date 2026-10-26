# ZCode 复用功能验证记录

日期：2026-10-24。环境：macOS arm64、Bun 1.3.14。目标：当前 `packages/workflow-agent` 源码。测试使用临时目录、假凭据和本机模型服务，没有调用付费模型，没有改动用户实际配置或导入实际个人技能。

## 自动检查

| 检查 | 结果 |
|---|---|
| `bun test packages/workflow-agent/test` | 301 通过、7 条原生沙箱测试按开关跳过、0 失败 |
| `MY_AGENT_SANDBOX_TEST=1 bun test packages/workflow-agent/test/sandbox.test.ts` | 原生环境单独运行，7 通过、0 失败 |
| `bun test packages/workflow-agent/test/model-trace.test.ts packages/workflow-agent/test/model-trace-store.test.ts` | 最后一次媒体省略修复后重跑，10 通过、0 失败 |
| SDK 相关 4 个测试文件 | 157 通过、0 失败 |
| `bun run --cwd packages/workflow-agent check` | lint、格式、TypeScript 检查通过 |
| SDK 文件单独 lint/格式检查、`git diff --check` | 通过 |

SDK 检查文件：`sdk-context-file-refresh.test.ts`、`sdk-restricted-extension-provider.test.ts`、`agent-session-aside-delivery.test.ts`、`agent-session-retry-fallback.test.ts`。

技能测试覆盖按需只读扫描、`.agents` 与 `.system`、格式错误隔离、未选技能不启用、完整复制/链接、支持文件可读、关闭后撤回读取、同名和同目录冲突、旧链接仍占据同名位置、批量冲突、取消清理、启用失败撤回、忙碌与并发拒绝、越界/循环链接、体积上限和真实菜单控制流程。

轨迹测试覆盖默认关闭、扩展不能代替用户开启、真实本机 HTTP 请求与捕获字段一致、会话隔离、重启不续开、主请求/旁路并发不串响应、工具调用/结果关联、401 错误、取消、磁盘写入失败不影响回答、恢复后可查看、对比不发新请求、凭据掩码、媒体/循环/大对象省略、实际磁盘体积上限及 100 条保留策略。

原生沙箱覆盖既有保护及新增技能读取例外：启用技能的参考文件可读；技能写入与应用私有状态读取被拒绝；关闭技能后读取被拒绝。首次尝试在宿主限制环境内出现 `sandbox_apply: Operation not permitted`；随后经工具自动审批在原生环境重跑。新增用例最初误读不含正文的任务摘要，改为检查真实工具日志后，完整 7 项通过。

## 终端实测

通过真实 PTY 启动：

```sh
bun run agent --demo --home /private/tmp/my-agent-zcode-terminal-v25ofbzd/home --cwd /private/tmp/my-agent-zcode-terminal-v25ofbzd/workspace
```

实际键盘操作完成：开启记录 → 发送第一个问题 → `/resources` 选择自定义来源 → 勾选单个技能 → 预览 → 复制 → 确认启用 → 发送第二个问题 → `/trace compare` 展示差异 → 关闭记录 → 再发一个问题 → 正常退出。

导入结果为 1 个启用、0 跳过、0 失败。参考文件内容完整，第二次请求出现技能名称/说明，第一次没有。两条记录均为 `stop`，磁盘大小分别为 30289 与 31083 字节，权限为 `0600`；比较及关闭后第三个问题没有新增轨迹。比较界面实际显示第二个问题的新增字段。演示回答仅来自本机固定服务，不证明真实模型会正确使用技能。

## 审查与修复

独立轨迹审查给出初步问题后，审查助手因额度限制退出，未生成完整最终报告；技能实现助手也在收尾前退出。协调者检查并完成余下实现、复现、修复及验证，不能将此记录称为完整独立审查通过。

已核实并处理的问题：

- `token` 凭据字段漏掩码：新增会失败的回归后修复。
- 紧凑 JSON 大小小于真正缩进写盘大小，导致写出的记录被读取器拒绝：按实际编码计算上限，深层请求回归通过。
- 请求接口并非所有供应商最终网络报文：记录捕获阶段并在菜单、对比和文档披露后续转换/重试边界。
- 应用目录保护挡住导入技能读取：增加仅启用技能目录的读取例外，同时验证写入、状态与凭据保护。
- 不同来源同目录名在菜单中不能区分：显示唯一编号、技能名和路径，独立选择回归通过。
- 留在托管目录的旧链接被冲突扫描遗漏：显式检查已有链接来源，保留原同名技能。
- 短 Base64 图片/音频未被普通二进制检查覆盖：按媒体结构省略并通过回归。

## 仍未验证与交付状态

尚未验证：真实付费模型；所有供应商的正文接口覆盖；Linux/Windows；用户实际技能依赖、脚本与工作任务。独立 `/review`、权限审核器和子代理请求未接入这次轨迹功能；任意正文的完全脱敏不作保证。

本次交付为当前工作区源码及文档，未提交 Git、推送、安装或发布。人工验收仍待用户在自己的终端按[使用说明](workflow-agent-zcode-reuse.md)试用；自动测试不会代替用户验收。
