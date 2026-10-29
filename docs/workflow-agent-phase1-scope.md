# 第一阶段 TUI 范围修订

日期：2026-10-15。依据用户本轮直接确认：TUI 主要面向有一定编程基础的人群；会话恢复可手动执行命令，不要求完全开箱即用。

本记录修订原第一阶段计划中对普通用户界面和安装体验的要求。它不表示第一阶段已完成，最新证据见 [本地交付记录](workflow-agent-delivery.md)，历史证据见 [MCP 记录](workflow-agent-mcp.md) 与 [迁移记录](workflow-agent-migration.md)。

## 本阶段可以接受的使用方式

- 允许编辑配置文件、设置环境变量和执行命令；保留最小配置示例、字段校验和可操作报错。
- 会话保存及恢复沿用现有产品命令，不新增恢复向导、会话浏览器或恢复菜单作为完成条件。
- 手动安装依赖、准备原生组件可以接受，但步骤必须在干净测试目录可重复，不能依赖开发机未说明的缓存或路径。
- 独立安装器、全套模型/搜索配置表单及普通用户引导不作为第一阶段门槛。命名预设启动、草稿管理和默认绑定已实现；运行中切换及 GUI 仍属后续阶段。

## 当前验收缺口（2026-10-29）

- 历史、任务、来源、撤销和预设恢复已有自动/真实终端验证；继续保留长任务和用户试用，已失效授权不恢复。
- OpenCode Go 的最小真实链路、辅助式代码任务及 Exa 来源链已完成；Tavily 真实账号、断网/限流与更广研究质量仍待验收。
- 原入口及后续稳定性回移已有限定审查；本轮 Windows 与准备流程的具体剩余边界见 [批次 1](verification/batch1-cross-platform-2026-10-29.md)。
- 源码准备已实现；两端具体首次安装证据以 [当前交付](workflow-agent-delivery.md) 为准，独立安装包另行验收。
- 原定六项任务的用户接受状态统一维护在 [任务验收](workflow-agent-acceptance.md)，不把已执行的代码样例重新列为零进展。

## 免费搜索 MCP 候选

以下按 2026-10-15 查阅的官方文档/项目仓库记录。本轮已在临时目录真实验证 Exa 的连接、搜索、网页读取与来源链，其余候选尚未实测；未改变 Tavily 默认值或用户配置。

| 方案 | 免费条件与限制 | 与当前产品的关系 |
|---|---|---|
| [Exa 官方 MCP](https://exa.ai/docs/get-started/exa-mcp) | Keyless 模式免登录/密钥，免费但有限流；可用搜索与网页读取，高阶 Agent 工具需认证 | `https://mcp.exa.ai/mcp` 按接口与当前 HTTP MCP 配置匹配，建议先做无凭据试用 |
| [Tavily 官方 MCP](https://github.com/tavily-ai/tavily-mcp) | [每月 1,000 免费积分](https://docs.tavily.com/documentation/api-credits)，需账号/密钥，无需信用卡；basic 搜索每次 1 分，advanced 每次 2 分 | 已有 Tavily API 研究链；MCP 也可用 Bearer 头引用密钥，不必把密钥写进 URL |
| [DuckDuckGo 社区 MCP](https://github.com/nickclyde/duckduckgo-mcp-server) | 无搜索 API 密钥配置要求，MIT；需本地 Python/uv 环境。仓库记录上游拦截和限流问题 | 支持 stdio/Streamable HTTP；安装和沙箱内依赖、网络可用性须实测，不把免费视为无限量或稳定保证 |
| [SearXNG 社区 MCP](https://github.com/ihor-sokoliuk/mcp-searxng) | 无搜索厂商 API 密钥要求，但需自己运行/选用 SearXNG 实例，承担资源和维护成本 | 支持 stdio/HTTP；公用实例可能关闭 [JSON 搜索接口](https://docs.searxng.org/dev/search_api.html)，优先考虑自己管理的实例 |

Exa 的配置片段可合并到产品 `config.json` 的 `mcpServers`：

```json
{
  "mcpServers": {
    "exa": {
      "type": "http",
      "url": "https://mcp.exa.ai/mcp",
      "enabled": true
    }
  }
}
```

此片段只声明服务，仍要求工具联网开关允许、重启后应用、按需批准连接和调用。示例未写入用户配置。

当前内置 `web_search` 走 Tavily API。添加 Exa MCP 后，可用 `mcp_list`/`mcp_call` 搜索；它不会自动替换内置工具或自动加入研究来源记录。若研究报告使用 MCP 找到的来源，可再用产品 `web_fetch` 读取真实 URL 进入现有来源链；若改成内置搜索后端，需补相应适配和验证。
