# OMP 产品入口实施计划

> 在当前任务串行执行，沿用已授权路线；不创建提交、分支、全局安装或发布。按 test-driven-development 和 verification-before-completion 记录实际证据。

**Goal:** 交付可以从 OMP fork 启动且资源/执行范围明确的 My Agent 入口。

**Architecture:** 私有 workspace 包依赖 OMP SDK；启动器为会话设置独立环境；产品规则和显式工具处于 SDK 外层。未接入的执行入口拒绝运行。

**Tech Stack:** OMP 18.10.3，Bun 1.3.14，macOS arm64，Sandbox Runtime 0.0.50。

**Spec:** `docs/superpowers/specs/2026-10-13-workflow-agent-omp.md`。

## 全局约束

- 保留父目录 Pi 原型；所有运行必需文件放入 fork，不依赖父目录源码。
- 不读取真实全局凭据；开发测试仅使用假密钥和本地模型服务。
- 不启用尚未包装的原生执行能力；无批准时拒绝副作用。
- 使用现有 Bun workspace、包级检查和固定依赖，不运行 Rust 构建。

## 1. CLI 与独立启动

Files: `packages/workflow-agent/{package.json,tsconfig.json,src/launcher.ts,src/cli.ts,test/cli.test.ts}`，根 `package.json`、`bun.lock`。

- [x] 子进程合同覆盖 setup 配置、doctor 的 OMP/Bun 元数据与凭据状态、demo 离线回答及实际工作目录。
- [x] 建立私有 workspace 包；启动器用 `Bun.spawn` 将 HOME 保持原值、OMP 状态定向到 `--home`，转发退出码和信号；实际 CLI 静态导入 SDK。
- [x] 安装固定依赖并运行测试，验证不依赖父目录源码。

## 2. 资源和会话

Files: `src/runtime/{host,resources,state}.ts`、`src/prompts/*.md`、`test/host.test.ts` 及子进程夹具。

- [x] 测试临时项目中的 AGENTS、SYSTEM、skill、可执行扩展干扰不会进入实际模型请求或产生文件；选择的技能/指令可见；轻量请求无工具与工作流资源。
- [x] 实现 OMP `createAgentSession` 显式资源和工具配置，配置与凭据采用独立/内存存储，禁用自动发现。
- [x] 原生历史及修改记录恢复、配置签名不匹配、跨工作区恢复、跨配置目录恢复拒绝均已通过集成检查；原生会话切换拒绝路径已有测试。

## 3. 受控工具与旧产品合同

Files: `src/{config,policy,processes,changes,research,workflow}`、`src/storage.ts`、`src/runtime/tools.ts`、`test/{core,research,processes,sandbox}.test.ts`。

- [x] 移入并运行旧核心合同测试，涵盖拒绝、路径、来源、报告、修改冲突、后台取消。
- [x] 迁移不依赖 Pi 的已验证实现，按仓库 API/类型规则调整；文件操作接 OMP，命令只走产品 Supervisor/Sandbox。
- [x] 模型实际调用写入：无批准不生成文件；有批准生成文件并留下恢复记录。验证原生 `!`/Python 入口拒绝，eval、MCP 和其他工具不在模型清单。
- [x] 在普通 macOS 主机执行环境验证实际工具的临时目录、越界读写和联网限制；确认退出清理命令。

## 4. 原生 TUI 与交付记录

Files: `src/tui/extension.ts`、包 README/CHANGELOG、父工作区 NEXT/README。

- [x] 接入原生 TUI 与 `/agent` 产品入口，展示实际资源、权限和未支持能力；设置修改在重启后应用。
- [x] 在真实 PTY 中验证离线回答、产品命令、指定工作目录、正常退出及提示命令恢复。
- [x] 运行包级 `bun run check` 和相关测试，完成自查并修复有复现的问题；独立审查因服务额度限制未运行。
- [x] 记录准确命令、范围、未验证项和回退路径；区分入口迁移完成与整个第一阶段/真实任务验收。

## 执行结果与实际调整（2026-10-14）

- 产品全部测试 33 通过，包含 2 项实际 macOS 沙箱测试；上游设置/TUI 兼容测试 52 通过；包级检查通过。
- 为禁用原生项目设置发现并提供正确的快捷键/恢复提示，增加三个上游文件的可选嵌入参数，默认原生行为不变。
- 沙箱补充最终 macOS 保护规则；文件操作复用原生客户端写入桥检查最终内容大小。准备中退出、技能重名、超限编辑/报告均有先失败后通过的回归证据。
- 详细结果、原始日志位置、安装边界与后续任务见 `docs/workflow-agent-migration.md`。真实服务、独立审查、MCP/扩展、分发和用户验收未完成。
