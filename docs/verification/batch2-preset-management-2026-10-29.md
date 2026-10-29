# 批次 2：预设管理与默认选择验收

日期：2026-10-29，Windows x64 / Bun 1.3.14 / OMP 18.10.3。批次 1 已按用户要求提交为 `bc8ae2f29d`，未推送；本批补丁未提交。使用本机模拟模型和独立临时 home/cwd，没有读取真实密钥或发起付费模型请求。

## 当前交付

- `/preset` 与 `/agent` 的预设管理菜单支持创建/复制、草稿编辑、资源选择、检查、差异预览、保存和取消。`/preset edit ID` 直接打开编辑器。CLI 新增 copy/clone、bind/unbind、default 及 default --clear。
- 名称、模式、指令/技能/附加提示词、工具、模型 key、MCP 名称和权限均可由菜单选择。技能目录先扫描再选择具体 SKILL.md，不自动启用新增候选；不扫描整个用户目录。菜单只管理引用，不连接模型或 MCP。
- 取消草稿不写清单，保存前校验并预览，确认后再写入。文件定义变更或另一个写入者持有锁时拒绝覆盖；内置定义只读，可复制。预设本地资源在复制时保留为原文件绝对引用，不复制历史、资源文件、凭据或临时授权。
- 保存只影响后续启动，当前运行仍冻结原配置。显示名修改保持身份；能力、资源等清单变化仍受既有恢复校验约束，不自动迁移旧历史，也不持久化 full。
- 普通新启动为显式 --preset、工作区绑定、全局默认、legacy；--light 保留旧轻量入口。--resume 没有显式预设时路由到原受控会话目录，不受新默认覆盖。宿主继续校验身份及资源，不把目录推断当作授权。
- 工作区记录只写用户 home 下的 workspaces，解析真实目录，Windows 另做大小写规范化；全局记录为 home/preset-default.json。与合法的 index.json 预设名不冲突。坏绑定明确报错，较低优先级的坏默认不影响有效的显式或工作区选择。

## 共享实现与边界

`presets/presets.ts` 是唯一校验/编译器，新增 compilePreset 供未保存草稿复用；store.ts 拥有版本检查、锁和落盘；editor.ts 通过小型 UI port 管理草稿；defaults.ts 负责绑定和启动选择。tui/presets.ts 只适配终端显示/输入，launcher 在 SDK 导入前确定目录。既有纯路径包含判断移到 policy/paths.ts，保留原 policy 导出和行为，避免轻量启动器导入整个权限/SDK 模块。

没有增加依赖、改变锁文件、预设 version=1 或会话格式，没有复制 Win/Mac 两套管理逻辑。平台分支仅用于 Windows 工作区键大小写和测试等待预算；相对资源路径以 / 保存。两端原有 Shell、隔离及进程适配未改。

模型来源的 /preset 命令在产品输入边界被拦截；菜单设置不改变当前权限、模型、MCP 或会话。未实现运行中切换、GUI、预设包、旧记录迁移或协作分支同步。

## 自动结果

| 检查 | 结果与范围 |
| --- | --- |
| 原基线 | 预设单元 6 pass；launcher 整组在 Windows 原 30 秒预算超时。仅调整有限测试预算，未宣称启动性能优化 |
| 三文件组合回归 | 19 pass / 0 fail，128 断言，203.72 秒；presets、preset-management、preset-launcher |
| 补充选择器回归后的管理单文件 | 12 pass / 0 fail，61 断言，95.55 秒；与上组重叠，不累加为总数 |
| 产品 check | oxlint、oxfmt、tsgo 全通过；初次 no-useless-spread 提示已移除，最终无该提示 |

组合回归包括真实 launcher 的三次独立 SDK 请求：工作区绑定选择 work、改绑 chat 后恢复原 work、显式 bare 覆盖默认。接收端验证所选规则/工具、原历史、恢复后写回同一会话，以及裸预设没有旧规则或聊天。用时 164.62 秒，本机假服务证明请求和隔离行为，不代表远端模型质量。

管理回归覆盖并发草稿/写锁、缺资源和缺模型、full 拒绝、复制本地引用、目录链接绑定、坏默认优先级、非法恢复路径、取消不写入、预览期间外部改动保护、命名/能力变化的恢复身份，以及模型触发管理命令被拒绝。最后新增一次技能/模型/MCP/权限联合选择：两项技能候选仅选择一项，模型只保存 secondary key，HTTP MCP 陷阱服务收到 0 次请求，预设不复制共享连接的 apiKeyEnv 字段。

复跑：

```sh
bun --no-env-file test packages/workflow-agent/test/presets.test.ts packages/workflow-agent/test/preset-management.test.ts packages/workflow-agent/test/preset-launcher.test.ts
bun --no-env-file run --cwd packages/workflow-agent check
```

## 真实 Windows 终端

通过原生 ConPTY 运行实际 `launcher --demo`、墨线界面和 SDK 对话框，独立 home/cwd：

1. 从 /preset 菜单创建 pty-cancel，进入编辑器后 Esc 取消，确认没有清单。
2. 创建 pty-work，修改显示名为 PTY Saved Work，查看只读差异；关闭预览后确认仍没有文件。
3. 在随后确认框批准保存，JSON 的 ID、名称和模式正确，界面通知下次启动生效。
4. 执行 /preset bind pty-work；/preset show 仍显示原 home/sessions，而非预设会话目录，当前运行未切换。
5. /quit 正常退出，退出码 0；原会话仍为一份 legacy 历史，新预设没有生成聊天目录，绑定记录正确。

终端转录及文件状态结果保留为 windows-pty-transcript.log、windows-pty-result.json。此为工具驱动的真实终端检查，不等同于人类接受、像素级视觉审查、输入法或鼠标操作验收。

## 证据与下一关

最终审查为 25 个文件、1615 行增删，含未跟踪文件，未超 26 文件/3000 行预算；git diff --check 通过。当前使用文档及修改文档共检查 30 份、120 个本地链接，0 断链。

本机日志位于 `E:/myagent/.verification-tools/batch2-2026-10-29/`：presets-first.log、presets-final.log、editor-final.log、check-final.log、check-reviewed.log，以及上述终端记录。测试配置、文件和服务均为受控临时数据，不是运行依赖或发布文件。

本轮未在真实 Mac 执行新增编辑界面，未跑完整 Windows 产品全量，也未重做付费模型/真实 Tavily 任务。Win/Mac 共用源码不替代 Mac 实机证据。批次 1 的原生 Windows .acl-init.lock 拒绝访问与 Mac 新准备复验仍单独保留，不因本批管理通过而关闭。

下一批为运行中切换：空闲门禁、进程交接、旧会话保存、MCP/后台清理和启动失败回退；本批没有开放 /preset use。
