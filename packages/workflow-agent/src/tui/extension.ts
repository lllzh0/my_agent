import * as path from "node:path";
import type { ExtensionFactory, ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import type { RunState } from "../runtime/state";
import type { Approver } from "../policy/policy";
import { resourcesFromCommand } from "./resources";
import { resourceDisabled } from "../runtime/resources";
import { atomicJson, redact } from "../storage";
import { mcpMenu } from "./mcp-menu";
import {
	handleProductCommand,
	parseProductCommand,
	restoreFromCommand,
	showProductData,
	toggleProductPlan,
} from "./commands";
import { selectPermissions, updateProductStatus } from "./permissions";

export function productExtension(
	state: RunState,
	approve: Approver | undefined,
	onShutdown: () => Promise<void>,
	getSession: () => AgentSession | undefined,
	isSessionSwitchAllowed: (target: string | undefined) => boolean = () => false,
): ExtensionFactory {
	return api => {
		const show = showProductData;
		let approvalContext: ExtensionContext;
		api.on("session_start", (_event, ctx) => {
			approvalContext = ctx;
			state.policy.setApprover(
				approve ??
					(async request => {
						const ctx = approvalContext;
						if (!ctx.hasUI) return "deny";
						const choice = await ctx.ui.select(
							replaceTabs(
								`批准 ${request.tool}\n${String(redact(request.target))}\n${JSON.stringify(redact(request.parameters ?? {}))}${request.review ? `\n${request.review.reason}` : ""}`,
							),
							["仅本次允许", "允许本会话完全相同的请求", "拒绝"],
						);
						return choice === "仅本次允许" ? "once" : choice === "允许本会话完全相同的请求" ? "session" : "deny";
					}),
			);
			updateProductStatus(state, ctx);
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
		api.on("tool_call", event => {
			if (resourceDisabled(state.config, `tool:${event.toolName}`))
				return { block: true, reason: "此工具已被用户关闭；只能由用户通过 /resources 重新开启。" };
			if (event.toolName !== "goal") return;
			const input = event.input as { op?: unknown };
			const goal = getSession()?.getGoalModeState();
			if (!goal || (input?.op !== "get" && !(input?.op === "complete" && goal.enabled)))
				return {
					block: true,
					reason: "目标和预算只能由用户通过 /goal 管理；模型只能查看或确认已验证完成的当前目标。",
				};
		});
		api.on("input", async (event, ctx) => {
			approvalContext = ctx;
			try {
				state.models?.assertSubmissionAllowed();
				state.review?.assertSubmissionAllowed();
				state.liveResources?.assertSubmissionAllowed();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "模型连接不可用", "error");
				return { handled: true };
			}
			if (
				event.source === "extension" &&
				["model", "review", "resources", "agent"].includes(parseProductCommand(event.text)?.name ?? "")
			) {
				ctx.ui.notify("资源开关、产品菜单、模型连接和独立代码审查只能由用户主动调用。", "error");
				return { handled: true };
			}
			if (state.sessions?.busy || state.sessions?.closed) {
				ctx.ui.notify(
					state.sessions.closed ? "会话正在关闭，无法接收新输入。" : "正在切换会话，请稍后再输入。",
					"info",
				);
				return { handled: true };
			}
			if (event.source === "extension" && ["resume", "new"].includes(parseProductCommand(event.text)?.name ?? "")) {
				ctx.ui.notify("会话只能由用户主动恢复。", "error");
				return { handled: true };
			}
			if (event.source === "extension" && ["goal", "btw"].includes(parseProductCommand(event.text)?.name ?? "")) {
				ctx.ui.notify("目标管理和旁问只能由用户主动调用；模型请使用当前目标的 goal 工具。", "error");
				return { handled: true };
			}
			if (event.source === "extension" && /^\/permissions(?:\s|$)/.test(event.text.trim())) {
				ctx.ui.notify("授权方式只能由用户主动切换。", "error");
				return { handled: true };
			}
			if (event.source !== "extension" && !parseProductCommand(event.text)) state.policy.setUserTask(event.text);
			if (parseProductCommand(event.text)?.name === "agent" && !parseProductCommand(event.text)?.args) {
				await openAgentMenu(ctx);
				return { handled: true };
			}
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
		api.on("session_before_switch", (event, ctx) => {
			if (event.reason === "resume" && isSessionSwitchAllowed(event.targetSessionFile)) return;
			return cancelTransition(event, ctx);
		});
		api.on("session_before_branch", cancelTransition);
		api.on("session_before_tree", cancelTransition);
		api.on("session_shutdown", async () => {
			await state.liveResources?.close();
			await state.sessions?.close();
			state.policy.clearGrants();
			await state.mcp.close();
			await state.jobs.close();
			await atomicJson(path.join(state.stateDir, "audit.json"), state.policy.audit);
			await onShutdown();
		});
		api.registerCommand("agent-plan", {
			description: "切换产品只读计划与执行模式",
			handler: async (_args, ctx) => {
				toggleProductPlan(state, ctx, getSession());
			},
		});
		async function openAgentMenu(ctx: ExtensionContext): Promise<void> {
			approvalContext = ctx;
			const choice = await ctx.ui.select("My Agent", [
				"实际资源与工具",
				"修改资源选择",
				"权限状态",
				"切换授权方式",
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
				try {
					await resourcesFromCommand(state, ctx);
				} catch (error) {
					ctx.ui.notify(replaceTabs(String(error)), "error");
				}
			} else if (choice === "切换授权方式") {
				await selectPermissions(state, ctx, "", () => {
					ctx.signal?.throwIfAborted();
					if (
						!ctx.isIdle() ||
						ctx.hasPendingMessages() ||
						getSession()?.hasPostPromptWork ||
						getSession()?.isCompacting
					)
						throw new Error("会话仍在运行；先停止后再切换授权方式。");
				});
			} else if (choice === "MCP 外部工具") await mcpMenu(state, ctx.ui, ctx.signal);
			else if (choice === "权限状态") {
				await show(ctx, "权限", {
					mode: state.policy.mode,
					permissions: state.policy.approvalMode,
					sandbox: state.sandbox.status,
					allowedDomains: state.config.sandbox.allowedDomains,
					note: "使用 /permissions 切换授权；完整授权不使用命令沙箱。计划模式独立保持只读。",
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
		}
		api.registerCommand("agent", {
			description: "My Agent 资源、权限、来源、后台与恢复",
			handler: async (_args, ctx) => openAgentMenu(ctx),
		});
	};
}
