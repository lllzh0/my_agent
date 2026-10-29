# 第一阶段：MCP 使用与实现记录

> 范围说明（2026-10-29）：本文的日期、测试数、保存状态和“未覆盖”描述属于原历史轮次，不是当前待办。当前能力及 Win/Mac 证据以 [交付说明](workflow-agent-delivery.md) 为准。

当前 Windows 例外：HTTP MCP 可用；隔离 stdio 的 stdin 尚不可用，普通权限在进程启动前拒绝。只有用户显式选择 full 时才直接执行本地 MCP，见 [Windows 边界](workflow-agent-windows.md)。

更新：2026-10-15。**产品入口已接入选定的 HTTP 和本地 MCP 服务，自动测试与真实终端流程通过；用户所选外部服务及第一阶段真实任务尚未验收。**

MCP 是让 agent 调用其他程序工具的协议。本次复用 OMP 现有客户端和通信实现，在产品侧增加配置、批准、隔离和清理。它解决第一阶段 F08/F09 的外部工具入口，不引入另一套模型循环或完整预设系统。

## 怎样使用

1. 在 fork 中运行 `bun run agent --demo` 检查菜单；真实模型运行时去掉 `--demo`。
2. 输入 `/agent`，选择“MCP 外部工具”，添加远程 HTTP 或本地 stdio 服务。stdio 表示通过本地程序的输入输出通信，程序需预先安装。
3. 如需认证，只填写环境变量名；在自己的启动终端设置该变量。菜单不会接收或保存真实密钥。
4. 退出并重启。选择“连接并查看工具”，核对目标后批准连接。模型也可以通过 `mcp_list` 请求连接；每次业务调用由 `mcp_call` 按完整参数单独授权。
5. 在同一菜单断开。要长期停用，保存停用配置并重启；它不改变当前会话已选中的连接集合。

保存、启动、查看状态和 `doctor` 都不会自动连接。单个服务配置错误显示 `invalid`，不会使整个 agent 无法聊天。启用、添加或替换配置都在下次启动生效；当前进程保留启动时的快照。

`--demo` 的模型只返回固定回答，适合验证菜单，不会替用户规划 MCP 工具调用。菜单连接仍会访问你选定的服务并可能启动本地程序，应核对批准信息。本轮试跑使用了本机模拟服务。

## 配置示例

下面是 `config.json` 中的 `mcpServers` 部分。请使用实际服务地址；示例地址不会提供服务。

```json
{
  "mcpServers": {
    "research": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${RESEARCH_MCP_KEY}" },
      "timeout": 30000,
      "enabled": true
    },
    "local-tools": {
      "type": "stdio",
      "command": "/绝对路径/已安装的程序",
      "args": ["--stdio"],
      "env": { "SERVICE_KEY": "${LOCAL_MCP_KEY}" },
      "timeout": 30000,
      "enabled": false
    }
  }
}
```

远程支持 Streamable HTTP：外部地址必须使用 HTTPS，HTTP 只允许 `localhost`、`127.0.0.1` 或 `[::1]`。地址不能含用户名、密码、查询参数或片段；认证放在环境变量引用中。跨来源跳转会被阻止，不会将请求正文或认证头发到另一个来源。MCP OAuth、旧 SSE、服务端模型采样请求和任意宿主代码扩展尚未开放。

`headers`、`env` 的值必须是 `${ENV_NAME}`，认证头可带 `Bearer ` 等前缀。不支持执行命令取密钥。模型和搜索密钥不会自动传给本地程序；`HOME` 使用产品临时目录，`PATH` 等启动变量由产品管理。多组变量或其他认证头可编辑配置文件。连接/调用超时默认 30 秒，可设为 100–120000 毫秒，不能设为 0；HTTP 关闭请求最多额外等 1 秒。

## 批准与执行边界

- 连接本地服务本身会启动程序，因此连接也需要批准。连接批准不等于允许使用其所有工具；工具自报“只读”也不跳过批准。会话许可仅复用完全相同的请求。
- 计划模式禁止连接和调用；等待批准期间切换计划模式，也会在执行前重新检查。轻量模式没有 MCP 工具和连接。
- 远程 MCP 要求 `permissions.allowNetwork` 为 true，目标来自明确保存的配置。本地服务除这一联网开关外，还沿用命令沙箱的 `sandbox.allowedDomains`，默认不能联网。
- 本地服务固定在当前工作区执行，只开放工作区、允许的读取目录和产品临时目录；常见凭据、产品状态和工作区外写入受限。沙箱准备失败不会降级成普通执行。
- 关闭连接及正常退出会清理本地进程组；HTTP 清理有独立截止时间，不受 OMP 全局“关闭超时”设置影响。崩溃恢复不会按历史 PID 杀进程。
- 取消、断线或超时后，服务可能已执行操作。产品提示结果未知，不自动重放业务请求；先用菜单或 `mcp_list` 重新连接，再核实结果。本地或远程 MCP 的修改不属于文件菜单撤销范围。
- 服务端 instructions 不追加到系统提示；工具说明与结果作为外部数据返回。返回内容会脱敏并限制传给模型的长度，但这不能证明外部服务本身可靠，也不保证所有恶意响应都已被隔离。

## 常见失败

| 表现 | 处理 |
|---|---|
| 配置无效，聊天仍正常 | 用 `doctor` 或 MCP 状态查看具体字段；修正后重启 |
| 缺少环境变量 | 在启动产品的终端设置对应变量后重启，不把密钥写进配置或启动参数 |
| 本地程序找不到依赖或无法读取文件 | 检查程序路径及 `permissions.readRoots`；用户目录中的运行时或依赖可能需要明确开放读取范围 |
| Bun 服务一启动就 EOF | Bun 可能尝试自动读取项目 `.env`，这会被沙箱拒绝；使用 `bun --no-env-file /路径/server.ts`，所需变量通过 `env` 传入 |
| 本地服务无法联网 | 在 `sandbox.allowedDomains` 设置所需域名后重启；不通过关闭沙箱绕过 |
| 调用未正常返回 | 先检查服务端是否已完成操作，不直接重复写入类请求 |

## 实现与验证

产品新增 `src/mcp/config.ts`、`manager.ts` 与 `src/tui/mcp-menu.ts`；工具入口和退出顺序接入现有宿主。OMP 的 stdio/HTTP 客户端仅增加可选控制，原生调用未选择时保留默认策略。没有新增依赖、自动安装包、提交或发布。

| 检查 | 本轮结果 |
|---|---|
| 产品全部测试 | 51 通过、0 失败，8 文件；包含 3 项真实 macOS 沙箱测试 |
| OMP MCP 针对性测试 | 94 通过、0 失败，7 文件 |
| 产品静态、格式、类型 | oxlint、oxfmt、tsgo 通过 |
| 修改过的原生 MCP 文件 | oxlint 与格式检查通过 |
| 真实终端 | 添加 HTTP、保存后重启、查看未连接状态、批准连接、查看工具、断开、正常退出通过 |
| 独立代码审查 | 本批 MCP 改动审查完成，三项发现修复并复测，无剩余阻断发现 |

审查发现并修复的三项问题：带引号/反斜杠的凭据未完整脱敏，以及对字面值替换会破坏 JSON 布尔结果；立即退出时已取消的请求仍启动授权并产生未处理异常；旧 OMP 环境变量禁用超时后，HTTP 清理可能持续等待。分别用真实返回内容、立即关闭和本机延迟服务复现后修复，回归测试纳入上述计数。stdio 并发与重入关闭也已测试，所有调用者等待进程清理完成。

2026-10-15 补查原有产品入口，修复了两条旧路径：shell 正常完成后留下重定向输出的后台子进程，以及等待批准期间切到计划模式后仍被旧批准放行。前者在主进程退出时清理同组后代，后者在共用权限层批准后再次检查；两项回归均先复现失败、再验证通过，已纳入 51 项产品测试。原有入口的完整独立审查未取得最终结论，不将这一轮局部复核标记为全量通过。

复跑命令（fork 根目录）：

```sh
bun run --cwd packages/workflow-agent check
MY_AGENT_SANDBOX_TEST=1 bun test packages/workflow-agent/test
bun test packages/coding-agent/test/mcp-embedded-controls.test.ts \
  packages/coding-agent/test/mcp-header-policy.test.ts \
  packages/coding-agent/test/mcp-stdio-transport.test.ts \
  packages/coding-agent/test/mcp-http-transport.test.ts \
  packages/coding-agent/test/mcp-timeout.test.ts \
  packages/coding-agent/test/mcp-roots-list.test.ts \
  packages/coding-agent/test/mcp-manager-initial-connection-cleanup.test.ts
```

在外层受限环境中，macOS 沙箱测试需单独获得正常主机执行权限。未设置 `MY_AGENT_SANDBOX_TEST=1` 的测试会跳过三项 OS 检查。

日志与源文件指纹保存在父工作区 `artifacts/omp-mcp/`，与之前 `omp-product/` 的迁移证据分开。真实终端服务只收到初始化、工具目录与关闭请求，未调用业务工具；业务批准、拒绝和取消由自动集成测试覆盖。

本轮没有使用真实模型、Tavily 或第三方 MCP 凭据。未覆盖真实服务兼容性、所有终端菜单路径、跨平台、完整 OMP/Rust 构建、干净环境安装和六项日常任务的用户验收。先前产品迁移的完整独立审查仍待补，本次审查结论仅覆盖 MCP 这批改动。第一阶段仍需配置体验、独立分发和真实任务验收，再进入完整预设与 GUI。
