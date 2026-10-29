# OpenCode Go 请求头核对

> 范围说明（2026-10-29）：本文的日期、测试数、保存状态和“未覆盖”描述属于原历史轮次，不是当前待办。当前能力及 Win/Mac 证据以 [交付说明](workflow-agent-delivery.md) 为准。

核对日期：2026-10-15。针对用户提出的 Go 必需请求头检查，没有修改生产请求逻辑或用户配置。

## 官方要求

[OpenCode Go 官方说明](https://opencode.ai/v2/docs/console/go/#where-can-i-use-it) 要求每个对话携带稳定的 `x-opencode-session`，用于路由和提示词缓存，并使用客户端自己的 `User-Agent` 标识，而非通用 SDK 或 HTTP 库名称。

会话 ID 应随对话变化；同一对话的多轮请求、工具调用后继续请求以及恢复会话应保持一致。不要为所有对话配置同一个固定值，也不要在每次请求时重新生成。

## 当前实现

- `packages/ai/src/providers/inference-headers.ts` 已识别 `opencode-go`，将权威会话 ID 写入 `x-opencode-session`，并设置客户端 User-Agent。
- OpenAI 兼容请求和 Anthropic 请求使用共同的请求头处理；Go 的其他传输路径由现有底座测试覆盖。
- `packages/coding-agent/src/sdk.ts` 默认把产品传入的 SessionManager 会话 ID 交给模型循环；产品恢复使用同一会话身份。
- 当前 User-Agent 为 `omp/18.10.3`，是编码 Agent 底座的身份，没有伪装成其他客户端。

因此当前产品入口已自动携带该头，无需新增手动配置或重复注入。这个结论来自实际 HTTP 请求验证，不只来自搜索源码。

## 验证

新增产品回归 `packages/workflow-agent/test/opencode-headers.test.ts`，使用真实产品宿主、OMP SDK、HTTP/SSE 和本机假服务，在服务端接收请求处仅读取会话头及 User-Agent，不记录授权头或真实凭据。

两项检查通过：

1. DeepSeek V4.1 Flash 请求经过真实工具调用后，会话头仍与持久化会话 ID 一致；恢复后继续沿用；新会话改用新 ID。
2. 轻量模式仍发送会话头和 Agent User-Agent。

OMP 既有 `packages/ai/test/opencode-session-header.test.ts` 的 17 项检查通过，涉及 OpenAI 兼容、Google、Anthropic 等传输、缺省身份、冲突头和客户端标识。产品原有宿主回归 20 项通过，产品包 oxlint、oxfmt、tsgo 通过。证据摘要保存在父工作区 `artifacts/omp-opencode-headers/verification.json`。

这些检查没有使用真实 OpenCode Go 账号，没有向付费模型发出请求，不替代真实服务连通或任务质量验收。本轮只新增回归覆盖和文档；第一阶段真实模型与六项任务仍待验。

从 fork 根目录复跑：

```sh
bun --no-env-file test packages/workflow-agent/test/opencode-headers.test.ts
bun --no-env-file test packages/ai/test/opencode-session-header.test.ts
bun run --cwd packages/workflow-agent check
```
