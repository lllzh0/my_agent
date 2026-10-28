# 原生 Windows：启动与命令隔离

2026-10-28。新增 Windows x64 原生适配：OMP 18.10.3 组件、PowerShell 命令、本地 MCP、进程树取消、诊断及恢复命令。Windows arm64 的包选择路径已接入，尚未实机验证。Linux/WSL 不属于本批。

## 准备

使用 Windows 10/11、本地 NTFS 工作目录、Bun 1.3.14+ 和 Git。建议使用 Windows Terminal。先在普通 PowerShell 进入源码目录：

```powershell
bun run agent:prepare
bun run agent:sandbox status
bun run agent --demo --print --prompt '确认可以离线启动'
```

prepare 只安装源码依赖、生成工具视图并校验同版本原生组件；不安装系统沙箱。Windows x64 使用官方包中的 baseline 组件，不要求 AVX2。现有 macOS arm64 路径保留。

命令隔离需要主动进行一次系统安装：

```powershell
bun run agent:sandbox install
bun run agent:sandbox status
bun run agent doctor
```

安装会请求管理员 UAC，创建 `srt-sandbox` 本地账户、关联用户组和 WFP 网络规则。默认跳过整个用户目录的读取授权，也不开放任意 loopback 端口；普通启动不自动执行这些系统修改。未安装或检查失败时，普通/自动权限下命令和本地 MCP 拒绝启动。文件、聊天和 HTTP 研究功能不需要这次安装。

本入口要求没有整用户目录读取授权；若同机其他应用已授予该权限，会拒绝执行并提示，不擅自撤回其他应用的授权。默认依靠专用账户保护宿主私有目录，只在明确授权的目录内设置敏感路径 DENY，避免每次启动扫描并更新整个宿主用户目录的 ACL。

Windows 专用依赖精确固定为 `@anthropic-ai/sandbox-runtime@0.0.81`（别名 `@my-agent/windows-sandbox`）；macOS 继续使用原 0.0.50。系统安装和卸载会影响同机使用该上游沙箱的其他应用，应由机器使用者管理。卸载及残留 ACL 清理方式见 [上游 Windows 文档](https://github.com/anthropics/sandbox-runtime#windows-alpha)。

真实服务仍由用户在自己的终端设置环境变量：

```powershell
$env:OPENCODE_API_KEY = '你的密钥'
$env:TAVILY_API_KEY = '你的密钥'
bun run agent --cwd E:\your-project
```

## 命令和边界

- 产品 `bash` 工具名保持兼容，在 Windows 实际使用系统 Windows PowerShell，无 profile、非交互、UTF-8 输出，保留外部程序退出码；系统提示词说明实际平台。
- **Windows 普通权限暂不支持本地 stdio MCP**：本机 0.0.81 的隔离 stdin 实测为空，产品在启动前明确拒绝，不自动关闭隔离。可使用 HTTP MCP；只有用户显式选择 full 时，才直接运行本地 MCP 并由 SDK 解析程序、PATH/PATHEXT 和 `.cmd` 参数。full 路径不提供隔离。
- 使用原生稳定进程句柄清理子进程树；不向 Windows 发送负 PID 的 Unix 进程组信号。取消不撤销已经发生的副作用。
- 沙箱使用独立账户、受限令牌、NTFS ACL 和 WFP。工作区与显式目录获得所需权限；产品状态、凭据和执行配置受限。当前 Bun 所在的 bin 目录作为只读工具目录提供，其他装在个人目录的工具需要显式 readRoots。
- Windows 的目录授权在沙箱初始化时固定。资源热切换改变读取范围后，重新启动会话再执行命令；命名预设本来就采用启动时冻结的清单。
- 文件工具首批仅处理本地普通路径，不开放 UNC/设备路径、NTFS 备用数据流、设备保留名及末尾点/空格的歧义路径。
- `full` 仍只有人显式选择时才关闭隔离；安装缺失不会自动选择 full。

上游将 Windows 后端标为 **alpha**，其网络过滤不能视为可抵抗恶意原生代码的完整边界：文档列出系统服务代理的 SMB/WSL 流量和令牌模拟等限制。同机多用户与持久 ACL 也有额外约束。适合受信开发环境的试用，不将其称为虚拟机级隔离。[官方安全模型与限制](https://github.com/anthropics/sandbox-runtime#known-limitations)

本机实际探针也报告匿名令牌的 loopback 残余路径。另需注意，Windows 文件 glob 在初始化时展开，新出现的匹配路径不会自动获得限制；不要把敏感文件名匹配当作持续监控或完整防泄露机制。`env.local` 已同时纳入文件工具、命令隔离和 Git 忽略规则。

## 验证

普通验证不修改系统账户或网络规则：

```powershell
bun test packages/workflow-agent/test/distribution.test.ts packages/workflow-agent/test/windows-processes.test.ts packages/workflow-agent/test/windows-sandbox.test.ts
```

完成系统安装后，可在临时目录运行独立隔离验收（不调用模型）：

```powershell
$env:MY_AGENT_WINDOWS_SANDBOX_TEST = '1'
bun test packages/workflow-agent/test/windows-sandbox.test.ts
Remove-Item Env:\MY_AGENT_WINDOWS_SANDBOX_TEST
```

该验收检查工作区写入、受保护文件、越界写入、Git 元数据及网络拒绝；只证明这些具体行为。实际执行结果、依赖安装问题和待验收项见 [本批记录](verification/windows-2026-10-28.md)。
