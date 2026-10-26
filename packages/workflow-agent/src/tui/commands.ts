import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { parseSkillInvocation } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { replaceTabs, type SlashCommand } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RunState } from "../runtime/state";
import type { Change } from "../changes/journal";
import { latestFileTurn, restoreFileChanges } from "../changes/undo";
import { redact } from "../storage";
import undoneMessage from "../prompts/files-undone.md" with { type: "text" };
import { mcpMenu } from "./mcp-menu";
import { selectPermissions, updateProductStatus } from "./permissions";
import { selectModel } from "./model";
import { resumeFromCommand } from "./resume";
import { collectProductDiff } from "../review/diff";
import { reviewFromCommand } from "./review";
import { resourcesFromCommand } from "./resources";
import { resourceDisabled } from "../runtime/resources";
import { traceFromCommand } from "./trace";

const commands: SlashCommand[] = [
	{ name: "help", description: "显示当前产品支持的命令" },
	{ name: "agent", description: "打开产品主菜单" },
	{ name: "context", description: "查看上下文用量和已加载资源" },
	{
		name: "btw",
		description: "并行问旁支问题，或查看独立保存的旁支历史",
		argumentHint: "[问题]",
		allowArgs: true,
	},
	{ name: "model", description: "查看或切换本会话显式模型连接", argumentHint: "[key] [思考强度]", allowArgs: true },
	{ name: "effort", description: "查看或设置本会话思考强度", argumentHint: "[强度]", allowArgs: true },
	{ name: "retry", aliases: ["redo"], description: "重试上一轮失败或中断的回答" },
	{ name: "undo", description: "撤销最近一轮未恢复的文件工具修改，保留聊天" },
	{ name: "diff", description: "查看项目差异及未覆盖文件", argumentHint: "[本地基准]", allowArgs: true },
	{ name: "review", description: "对项目差异进行有请求上限的只读审查", argumentHint: "[本地基准]", allowArgs: true },
	{ name: "fresh", description: "重建模型连接状态，保留本地聊天" },
	{ name: "usage", description: "查看本会话本地 token 和费用统计" },
	{
		name: "trace",
		description: "开启本地请求轨迹、查看正文及比较请求差异",
		argumentHint: "[on|off|list|show <ID>|compare <ID-A> <ID-B>]",
		allowArgs: true,
	},
	{ name: "tools", description: "查看实际工具与资源清单" },
	{
		name: "resources",
		description: "热切换工具、技能、指令和附加提示词",
		argumentHint: "[list|on <ID>|off <ID>|reload]",
		allowArgs: true,
	},
	{
		name: "jobs",
		description: "查看后台任务、输出或停止任务",
		argumentHint: "[output <id> [cursor]|stop <id>]",
		allowArgs: true,
	},
	{ name: "todo", description: "查看产品任务进度" },
	{
		name: "goal",
		description: "持续推进目标，管理暂停、恢复和 token 预算",
		argumentHint: "[目标|set <目标>|show|pause|resume|drop|budget <N|off>]",
		allowArgs: true,
	},
	{ name: "mcp", description: "管理产品受控 MCP 连接" },
	{
		name: "permissions",
		description: "切换手动、自动或完整授权",
		argumentHint: "[manual|auto|full]",
		allowArgs: true,
	},
	{ name: "plan", aliases: ["agent-plan"], description: "切换产品只读计划与执行模式" },
	{ name: "compact", description: "压缩当前上下文", argumentHint: "[soft] [关注内容]", allowArgs: true },
	{ name: "session", description: "查看当前会话信息", argumentHint: "[info]", allowArgs: true },
	{ name: "resume", description: "恢复当前工作区的旧会话", argumentHint: "[会话ID]", allowArgs: true },
	{ name: "new", description: "保存旧会话并开始空白会话，重置授权" },
	{ name: "hotkeys", description: "查看快捷键" },
	{ name: "quit", aliases: ["q"], description: "退出并保存会话" },
];

export function productCommandCatalog(_state: Pick<RunState, "resources">): SlashCommand[] {
	return [...commands];
}

export function parseProductCommand(text: string): { name: string; args: string } | undefined {
	// Directory paths and dotted filenames are prompts. Keep colon-form commands
	// classified as commands even when their arguments contain paths: OMP also
	// accepts /name:args, so passing those through could invoke an unadapted builtin.
	const match = /^\/([a-zA-Z0-9_-]+(?::[^\s]*)?)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match) return { name: match[1], args: (match[2] ?? "").trim() };
}

export async function showProductData(ctx: ExtensionContext, title: string, data: unknown): Promise<void> {
	await ctx.ui.editor(title, replaceTabs(typeof data === "string" ? data : JSON.stringify(redact(data), null, 2)));
}

export function toggleProductPlan(state: RunState, ctx: ExtensionContext, session?: AgentSession): void {
	if (session?.getGoalModeState()?.enabled) throw new Error("目标仍在执行；先用 /goal pause 暂停，再切换计划模式。");
	state.policy.mode = state.policy.mode === "plan" ? "execute" : "plan";
	state.policy.clearGrants();
	updateProductStatus(state, ctx);
	ctx.ui.notify(
		state.policy.mode === "plan" ? "计划模式：禁止写入和命令执行。" : "已进入执行模式，按当前授权方式处理操作。",
		"info",
	);
}

/** Used by /undo and the existing per-change restore menu. */
export async function restoreFromCommand(
	state: RunState,
	ctx: ExtensionContext,
	api: ExtensionAPI,
	changes: Change[],
	ensureIdle: () => void,
): Promise<void> {
	if (!changes.length) {
		ctx.ui.notify("没有尚未恢复的文件工具修改。", "info");
		return;
	}
	try {
		ensureIdle();
		if (ctx.hasUI)
			await showProductData(ctx, "恢复预览（关闭后选择是否批准）", {
				files: [...new Set(changes.map(change => change.path))],
				diffs: changes.map(change => state.journal.diff(change.id)),
				note: "只恢复列出的直接文本修改；聊天保留。命令、Git、MCP 和外部服务不在范围内。",
			});
		await restoreFileChanges(state, changes, ensureIdle);
		ctx.ui.notify(`已恢复 ${new Set(changes.map(change => change.path)).size} 个文件；聊天记录保留。`, "info");
	} catch (error) {
		ctx.ui.notify(replaceTabs(error instanceof Error ? error.message : String(error)), "error");
	} finally {
		// A disk error during a batch may leave a subset restored. Tell the model
		// about exactly those files even if the command did not finish completely.
		const restored = changes
			.map(change => state.journal.get(change.id))
			.filter((change): change is Change => change?.restored === true);
		if (restored.length)
			api.sendMessage({
				customType: "file-undo",
				content: prompt.render(undoneMessage, {
					files: JSON.stringify([...new Set(restored.map(change => change.path))]),
				}),
				display: true,
			});
	}
}

export async function handleProductCommand(
	text: string,
	state: RunState,
	ctx: ExtensionContext,
	api: ExtensionAPI,
	getSession: () => AgentSession | undefined,
): Promise<InputEventResult | undefined> {
	const legacySkill = parseSkillInvocation(text);
	if (legacySkill) {
		ctx.ui.notify(
			`技能已改用 $ 调用；请输入 $${legacySkill.name}${legacySkill.args ? ` ${legacySkill.args}` : ""}。`,
			"info",
		);
		return { handled: true };
	}
	const parsed = parseProductCommand(text);
	if (!parsed) return;
	const { name, args } = parsed;
	const command = commands.find(command => command.name === name || command.aliases?.includes(name));
	if (!command) {
		ctx.ui.notify("此命令尚未接入产品入口；使用 /help 查看支持的命令。", "info");
		return { handled: true };
	}
	const usage = () => {
		ctx.ui.notify(`用法：/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`, "info");
		return { handled: true };
	};
	if (args && !command.allowArgs) return usage();
	if (command.name === "btw") {
		// Native TUI dispatch owns its independent request, Escape handling, and
		// side-history storage. It remains available while the main turn runs.
		if (ctx.mode === "tui") return;
		ctx.ui.notify("/btw 只支持交互终端；请启动终端界面后使用。", "info");
		return { handled: true };
	}
	if (command.name === "agent") return;
	if (command.name === "trace") {
		try {
			await traceFromCommand(state, ctx, args);
		} catch (error) {
			ctx.ui.notify(replaceTabs(error instanceof Error ? error.message : String(error)), "error");
		}
		return { handled: true };
	}
	if (command.name === "goal") {
		if (resourceDisabled(state.config, "tool:goal") && !/^(?:show|pause|drop)(?:\s|$)/i.test(args)) {
			ctx.ui.notify("goal 工具已关闭；请先 /resources on tool:goal。", "info");
			return { handled: true };
		}
		if (state.light) {
			ctx.ui.notify("轻量模式没有 goal 工具；请正常启动后使用 /goal。", "info");
			return { handled: true };
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/goal 需要交互终端；请在 TUI 中设置和管理目标。", "info");
			return { handled: true };
		}
		if (state.policy.mode === "plan" && !/^(?:show|pause|drop)(?:\s|$)/i.test(args)) {
			ctx.ui.notify("计划模式不能启动或恢复 goal；先用 /plan 切回执行模式。", "info");
			return { handled: true };
		}
		const paused = getSession()?.getGoalModeState();
		if (/^resume\s*$/i.test(args) && paused?.goal.status === "paused") {
			// A cold resume needs the saved objective; same-process resumes
			// must preserve any newer constraints the human already supplied.
			if (!state.policy.userTask.trim()) state.policy.setUserTask(paused.goal.objective);
		}
		return;
	}
	if (["quit", "hotkeys"].includes(command.name)) return;
	if (command.name === "compact") {
		if (/^(?:remote|snapcompact)(?:\s|$)/i.test(args)) return usage();
		// Explicitly use OMP's summarization path rather than remote/bitmap modes.
		return { text: `/compact ${/^soft(?:\s|$)/i.test(args) ? args : `soft ${args}`}`.trim() };
	}
	const session = getSession();
	if (!session) {
		ctx.ui.notify("会话尚未初始化。", "error");
		return { handled: true };
	}
	const ensureIdle = () => {
		ctx.signal?.throwIfAborted();
		if (!ctx.isIdle() || ctx.hasPendingMessages() || session.hasPostPromptWork || session.isCompacting)
			throw new Error("会话仍在运行或有排队消息；先按 Esc 停止并等待完成。");
	};
	try {
		switch (command.name) {
			case "resources":
				await resourcesFromCommand(state, ctx, args);
				break;
			case "model":
				await selectModel(state, ctx, args);
				break;
			case "resume":
				await resumeFromCommand(state, ctx, args, ensureIdle);
				break;
			case "new": {
				ensureIdle();
				if (!state.sessions) throw new Error("会话管理尚未初始化。");
				const result = await state.sessions.startNew(ctx.signal);
				updateProductStatus(state, ctx);
				ctx.ui.notify(
					result.refreshFailed
						? "新会话已创建，旧聊天和记录已保存、授权已重置；界面刷新失败，请退出后用 --resume 重新打开当前会话。"
						: "已开始空白会话；旧聊天和记录可通过 /resume 恢复，授权已按配置重置。",
					result.refreshFailed ? "warning" : "info",
				);
				break;
			}
			case "help":
				await showProductData(
					ctx,
					"命令帮助",
					productCommandCatalog(state)
						.map(
							command =>
								`/${command.name}${command.aliases?.length ? `（${command.aliases.map(alias => `/${alias}`).join("、")}）` : ""}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}`,
						)
						.join("\n") + "\n\n技能单独使用 $名称 [需求] 调用；输入 $ 查看已启用技能。",
				);
				break;
			case "context":
				await showProductData(ctx, "上下文", {
					usage: session.getContextUsage() ?? null,
					resources: state.resources.entries,
					note: "用量为本地估计，服务端统计可能不同。",
				});
				break;
			case "usage":
				await showProductData(ctx, "本地用量", {
					...session.getSessionStats(),
					automaticReview: state.policy.reviewUsage,
					codeReview: await state.review?.stats(),
					model: state.models?.current(),
					pricingStatus: state.models ? getModelPricingStatus(state.models.activeModel()) : undefined,
					note: "仅当前会话累计；按模型返回用量及目录价格估算，不代表订阅剩余额度或账单；未知价格时记录的 0 不能当作免费。",
				});
				break;
			case "session":
				if (args && args !== "info") return usage();
				await showProductData(ctx, "会话信息", {
					...session.getSessionStats(),
					cwd: state.cwd,
					mode: state.policy.mode,
					permissions: state.policy.approvalMode,
					storage: { changes: await state.journal.stats(), sources: state.research.stats() },
				});
				break;
			case "effort": {
				const available = session.getAvailableEffortSelectors();
				if (!args) {
					await showProductData(ctx, "思考强度", { current: session.configuredThinkingLevel(), available });
					break;
				}
				const selected = available.find(value => value === args);
				if (!selected) {
					ctx.ui.notify(`用法：/effort [${available.join("|") || "当前模型没有可选强度"}]`, "info");
					break;
				}
				ensureIdle();
				session.setThinkingLevel(selected, false);
				ctx.ui.notify(`本会话思考强度：${session.configuredThinkingLevel()}`, "info");
				break;
			}
			case "retry":
				ensureIdle();
				if (!(await session.retry({ skipCustomTypes: ["file-undo"] })))
					ctx.ui.notify("没有可重试的失败或中断回答。", "info");
				break;
			case "fresh":
				ensureIdle();
				session.freshSession();
				ctx.ui.notify("模型连接状态已重建，本地聊天保留；不会自动发送请求。", "info");
				break;
			case "undo":
				await restoreFromCommand(state, ctx, api, latestFileTurn(state), ensureIdle);
				break;
			case "diff":
				ensureIdle();
				await showProductData(ctx, "项目差异", await collectProductDiff(state, args || undefined, ctx.signal));
				break;
			case "review":
				ensureIdle();
				await showProductData(ctx, "代码审查结果", await reviewFromCommand(state, ctx, args || undefined));
				break;
			case "tools":
				await showProductData(ctx, "工具与资源", {
					tools: api.getActiveTools(),
					resources: state.resources.entries,
					light: state.light,
				});
				break;
			case "jobs": {
				const parts = args.split(/\s+/);
				if (!args) await showProductData(ctx, "后台任务", state.jobs.list());
				else if (
					parts[0] === "output" &&
					parts[1] &&
					parts.length <= 3 &&
					(parts[2] === undefined || /^\d+$/.test(parts[2]))
				)
					await showProductData(ctx, "后台输出", state.jobs.output(parts[1], Number(parts[2] ?? 0)));
				else if (parts[0] === "stop" && parts[1] && parts.length === 2) {
					await state.jobs.stop(parts[1]);
					ctx.ui.notify("后台任务已停止。", "info");
				} else return usage();
				break;
			}
			case "todo":
				await showProductData(ctx, "任务进度", state.workflow.tasks);
				break;
			case "mcp":
				await mcpMenu(state, ctx.ui, ctx.signal);
				break;
			case "permissions":
				await selectPermissions(state, ctx, args, ensureIdle);
				break;
			case "plan":
				toggleProductPlan(state, ctx, session);
				break;
		}
	} catch (error) {
		ctx.ui.notify(replaceTabs(error instanceof Error ? error.message : String(error)), "error");
	}
	return { handled: true };
}
