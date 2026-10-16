import * as path from "node:path";
import type { ExtensionFactory, ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import type { RunState } from "../runtime/state";
import type { Approver } from "../policy/policy";
import { saveConfig } from "../config/config";
import { atomicJson, redact } from "../storage";
import { mcpMenu } from "./mcp-menu";
import { handleProductCommand, restoreFromCommand, showProductData, toggleProductPlan } from "./commands";

export function productExtension(
	state: RunState,
	approve: Approver | undefined,
	onShutdown: () => Promise<void>,
	getSession: () => AgentSession | undefined,
): ExtensionFactory {
	return api => {
		const show = showProductData;
		let approvalContext: ExtensionContext;
		const status = (ctx: ExtensionContext) =>
			ctx.ui.setStatus(
				"my-agent",
				`My Agent · ${state.light ? "轻量" : state.policy.mode === "plan" ? "计划" : "执行"} · ${state.resources.entries.filter(entry => entry.loaded).length} 资源`,
			);
		api.on("session_start", (_event, ctx) => {
			approvalContext = ctx;
			state.policy.setApprover(
				approve ??
					(async request => {
						const ctx = approvalContext;
						if (!ctx.hasUI) return "deny";
						const choice = await ctx.ui.select(
							replaceTabs(
								`批准 ${request.tool}\n${String(redact(request.target))}\n${JSON.stringify(redact(request.parameters ?? {}))}`,
							),
							["仅本次允许", "允许本会话完全相同的请求", "拒绝"],
						);
						return choice === "仅本次允许" ? "once" : choice === "允许本会话完全相同的请求" ? "session" : "deny";
					}),
			);
			status(ctx);
			if (ctx.hasUI) {
				ctx.ui.setTitle("My Agent · OMP");
				ctx.ui.setHeader(
					() =>
						new Text("My Agent 0.2.0 · OMP\n编程与资料研究 · /help 命令 · /agent 主菜单 · /plan 计划模式", 1, 1),
				);
			}
		});
		api.on("agent_start", () => {
			state.turn = Bun.randomUUIDv7();
		});
		api.on("input", (event, ctx) => {
			approvalContext = ctx;
			return handleProductCommand(event.text, state, ctx, api, getSession);
		});
		// Native user shell hooks do not forward their cancellation token. Do not
		// run a replacement shell here until that lifecycle can be controlled.
		api.on("user_bash", () => ({
			result: {
				output: "此入口未接入产品沙箱，命令未执行。请让 agent 使用受控 bash 工具。",
				exitCode: 1,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 0,
				outputLines: 1,
				outputBytes: 0,
			},
		}));
		api.on("user_python", () => ({
			result: {
				output: "Python 直达入口未接入产品沙箱，代码未执行。",
				exitCode: 1,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 0,
				outputLines: 1,
				outputBytes: 0,
				displayOutputs: [],
				stdinRequested: false,
			},
		}));
		const cancelTransition = (_event: unknown, ctx: ExtensionContext) => {
			ctx.ui.notify("产品会话需要独立启动：请退出后重新运行；恢复时使用 --resume 会话文件。", "info");
			return { cancel: true };
		};
		api.on("session_before_switch", cancelTransition);
		api.on("session_before_branch", cancelTransition);
		api.on("session_before_tree", cancelTransition);
		api.on("session_shutdown", async () => {
			state.policy.clearGrants();
			await state.mcp.close();
			await state.jobs.close();
			await atomicJson(path.join(state.stateDir, "audit.json"), state.policy.audit);
			await onShutdown();
		});
		api.registerCommand("agent-plan", {
			description: "切换产品只读计划与执行模式",
			handler: async (_args, ctx) => {
				toggleProductPlan(state, ctx);
			},
		});
		api.registerCommand("agent", {
			description: "My Agent 资源、权限、来源、后台与恢复",
			handler: async (_args, ctx) => {
				approvalContext = ctx;
				const choice = await ctx.ui.select("My Agent", [
					"实际资源与工具",
					"修改资源选择",
					"权限状态",
					"MCP 外部工具",
					"研究来源",
					"后台任务",
					"文件修改与恢复",
					"任务进度",
					"配置位置与迁移范围",
				]);
				if (choice === "实际资源与工具")
					await show(ctx, "当前生效内容", {
						light: state.light,
						resources: state.resources.entries,
						tools: api.getActiveTools(),
					});
				else if (choice === "修改资源选择") {
					const action = await ctx.ui.select("保存后重启生效", [
						"添加指令文件",
						"添加技能目录",
						"清空工作流资源",
						"返回",
					]);
					if (!action || action === "返回") return;
					if (action === "清空工作流资源")
						state.config.resources = { instructions: [], skills: [], extensions: [], appendSystem: [] };
					else {
						const input = await ctx.ui.input("本地路径");
						if (!input) return;
						const file = path.resolve(state.cwd, input);
						if (action === "添加指令文件") state.config.resources.instructions.push(file);
						else state.config.resources.skills.push(file);
					}
					await saveConfig(state.home, state.config);
					ctx.ui.notify("配置已保存，重启后应用；当前会话仍使用原清单。", "info");
				} else if (choice === "MCP 外部工具") await mcpMenu(state, ctx.ui, ctx.signal);
				else if (choice === "权限状态") {
					await show(ctx, "权限", {
						mode: state.policy.mode,
						sandbox: state.sandbox.status,
						allowedDomains: state.config.sandbox.allowedDomains,
						note: "使用 /agent-plan 切换模式；! 和 Python 直达入口已关闭。",
					});
				} else if (choice === "研究来源")
					await show(
						ctx,
						"搜索发现与已读来源",
						state.research.sources.map(({ text, ...source }) => ({ ...source, excerpt: text.slice(0, 800) })),
					);
				else if (choice === "后台任务") {
					await show(ctx, "后台任务", state.jobs.list());
					const id = await ctx.ui.select("停止任务", [
						...state.jobs
							.list()
							.filter(job => job.status === "running")
							.map(job => job.id),
						"返回",
					]);
					if (id && id !== "返回") await state.jobs.stop(id);
				} else if (choice === "文件修改与恢复") {
					const changes = state.journal.list().filter(change => !change.restored);
					const id = await ctx.ui.select("直接文本修改", [...changes.map(change => change.id), "返回"]);
					if (!id || id === "返回") return;
					await restoreFromCommand(
						state,
						ctx,
						api,
						changes.filter(change => change.id === id),
						() => {
							if (
								!ctx.isIdle() ||
								ctx.hasPendingMessages() ||
								getSession()?.hasPostPromptWork ||
								getSession()?.isCompacting
							)
								throw new Error("会话仍在运行；先按 Esc 停止并等待完成。");
						},
					);
				} else if (choice === "任务进度") await show(ctx, "任务进度", state.workflow.tasks);
				else if (choice === "配置位置与迁移范围")
					await show(ctx, "产品配置", {
						config: path.join(state.home, "config.json"),
						model: state.config.model,
						search: state.config.search,
						note: "模型、域名和读取范围可编辑此文件，重启生效。MCP 使用主菜单管理；第三方代码扩展未接入。旧 Pi 会话不直接导入。",
					});
			},
		});
	};
}
