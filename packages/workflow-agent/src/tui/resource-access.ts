import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AccessDecision, AccessRequest } from "../runtime/temporary-access";
import type { RunState } from "../runtime/state";
import type { TemporaryMcp } from "../mcp/temporary";
import type { McpMenuUI } from "./mcp-menu";
import { redact } from "../storage";
import { formatPreviewText } from "./operation-preview";
import { chooseToolAccess } from "./tool-access";
import { InkDocument } from "./ink-document";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { truncateToWidth } from "@oh-my-pi/pi-tui";

const lifetime = "仅本次Agent运行有效；退出、重启或进程交接后清空。";

export async function showResourceDocument(ctx: ExtensionContext, title: string, body: string): Promise<void> {
	const text = formatPreviewText(body);
	if (!ctx.hasUI) {
		await ctx.ui.editor(title, text);
		return;
	}
	await ctx.ui.custom<void>(
		(tui, _theme, _keys, done) =>
			new InkDocument(
				title,
				text,
				() => Math.max(5, tui.terminal.rows - 2),
				() => done(),
			),
		{
			overlay: true,
			overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", margin: 1, mouseTracking: false },
			signal: ctx.signal,
		},
	);
}

export async function chooseResourceAccess(
	request: AccessRequest,
	select: (title: string, choices: string[]) => Promise<string | undefined>,
	inspect: (body: string) => Promise<void>,
): Promise<AccessDecision> {
	if (request.kind === "tool") {
		const args = request.details.arguments;
		return chooseToolAccess(
			{
				tool: request.key,
				reason: request.reason,
				arguments:
					args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
			},
			select,
			inspect,
		);
	}
	const once = request.kind === "skill" ? "仅加载这次" : "仅此次调用";
	const reason = formatPreviewText(request.reason, PREVIEW_LIMITS.EXPANDED_LINES)
		.split("\n")
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LONG))
		.join("\n");
	const body = formatPreviewText(
		[
			`${request.kind === "skill" ? "临时技能申请" : "临时 MCP 申请"} · ${request.label}`,
			lifetime,
			request.kind === "skill"
				? "只开放该技能包读取；已载入聊天的正文不会因撤销删除。"
				: "连接发现与指定工具分别批准；本次批准不会开放同服务其它工具。",
			"工具、写入、联网、计划模式和具体操作审批继续按原规则处理。",
			`申请理由：${reason}`,
			"",
			JSON.stringify(redact(request.details), null, 2),
		].join("\n"),
	);
	while (true) {
		const choice = await select(formatPreviewText(body, PREVIEW_LIMITS.EXPANDED_LINES), [
			once,
			"本次Agent运行有效",
			"拒绝",
			"查看申请详情（只读）",
		]);
		if (choice === "查看申请详情（只读）") {
			await inspect(body);
			continue;
		}
		return choice === once ? "once" : choice === "本次Agent运行有效" ? "run" : "deny";
	}
}

export async function skillsFromCommand(
	state: RunState,
	ctx: ExtensionContext,
	args: string,
	ensureIdle: () => void,
): Promise<void> {
	const access = state.skillAccess;
	if (!access) throw new Error("技能临时授权尚未初始化。");
	const guard = () => {
		ctx.signal?.throwIfAborted();
		ensureIdle();
		ctx.signal?.throwIfAborted();
	};
	const pick = async (title: string, choices: string[]) => {
		guard();
		const choice = await ctx.ui.select(formatPreviewText(title), choices, { signal: ctx.signal });
		guard();
		return choice;
	};
	const show = async () =>
		showResourceDocument(
			ctx,
			"技能状态 · 只读",
			[
				lifetime,
				"单次通过 $名称 或模型 request_skill 提交具体调用；读取该包不会放开其它工具或写入。",
				"撤销不删除聊天中已有正文。",
				"",
				...access
					.list()
					.map(
						entry =>
							`${entry.error ? "不可用" : entry.enabled ? "基线启用" : entry.temporary ? "临时启用" : "未启用"} · $${entry.name}\n  ${entry.path}${entry.error ? `\n  ${entry.error}` : ""}`,
					),
			].join("\n"),
		);
	const input = args.trim();
	if (input === "list" || (!input && !ctx.hasUI)) return show();
	if (!ctx.hasUI) throw new Error("技能授权管理需要人工交互终端；非交互模式请用 /skills list。");
	const change = async (op: "allow" | "revoke", name: string) => {
		const entry = access.list().find(item => item.name === name && !item.error);
		if (!entry) throw new Error("技能不在可用的已登记清单中。");
		const choice = await pick(
			`${op === "allow" ? "临时启用" : "撤销临时授权"} · $${name}\n${entry.path}\n${lifetime}\n只读取此技能包，已有聊天内容保留。`,
			[op === "allow" ? "本次Agent运行有效" : "撤销临时授权", "取消"],
		);
		if (choice !== (op === "allow" ? "本次Agent运行有效" : "撤销临时授权")) return;
		if (op === "allow") await access.grant(name, ctx.signal);
		else access.revoke(name);
		await state.liveResources?.syncSkills();
		ctx.ui.notify(
			op === "allow" ? `已临时启用 $${name}。${lifetime}` : `已撤销 $${name} 的临时授权；基线选择和已有正文保留。`,
			"info",
		);
	};
	const clear = async () => {
		if ((await pick("撤销全部技能临时授权；已有聊天正文保留。", ["撤销全部临时授权", "取消"])) !== "撤销全部临时授权")
			return;
		access.revoke();
		await state.liveResources?.syncSkills();
		ctx.ui.notify("技能临时授权已清空。", "info");
	};
	const match = /^(allow|revoke)\s+(\S+)$/.exec(input);
	if (match) return change(match[1] as "allow" | "revoke", match[2]);
	if (input === "clear") return clear();
	if (input) throw new Error("用法：/skills [list|allow <名称>|revoke <名称>|clear]");
	while (true) {
		const choice = await pick("技能临时授权", [
			"查看技能状态",
			"临时启用技能",
			"撤销技能授权",
			"清空技能授权",
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice === "查看技能状态") await show();
		else if (choice === "清空技能授权") await clear();
		else {
			const entries = access
				.list()
				.filter(
					entry =>
						!entry.error && (choice === "临时启用技能" ? !entry.enabled && !entry.temporary : entry.temporary),
				);
			if (!entries.length) {
				ctx.ui.notify("没有可操作的技能。", "info");
				continue;
			}
			const labels = entries.map(entry => formatPreviewText(`$${entry.name} · ${entry.description}`, 1));
			const selected = await pick("选择技能", [...labels, "返回"]);
			const entry = selected === undefined ? undefined : entries[labels.indexOf(selected)];
			if (entry) await change(choice === "临时启用技能" ? "allow" : "revoke", entry.name);
		}
	}
}

export async function temporaryMcpMenu(
	access: TemporaryMcp,
	ui: McpMenuUI,
	signal?: AbortSignal,
	ensureIdle: () => void = () => {},
): Promise<void> {
	const guard = () => {
		signal?.throwIfAborted();
		ensureIdle();
		signal?.throwIfAborted();
	};
	const pick = async (title: string, choices: string[]) => {
		guard();
		const choice = await ui.select(formatPreviewText(title), choices, { signal });
		guard();
		return choice;
	};
	const choice = await pick(`MCP 临时工具授权\n${lifetime}\n连接与操作审批独立，工具和网络限制保留。`, [
		"查看临时状态",
		"发现并临时启用工具",
		"撤销指定服务授权",
		"清空 MCP 临时授权",
		"返回",
	]);
	if (!choice || choice === "返回") return;
	if (choice === "查看临时状态") {
		await ui.editor(
			"MCP 临时状态",
			formatPreviewText(
				access
					.list()
					.map(
						entry =>
							`${entry.enabled ? "基线服务" : "候选服务"} · ${entry.name} · ${entry.connected ? "已连接" : "未连接"}\n${entry.target}\n${entry.tools.map(tool => `  ${tool.temporary ? "临时启用" : entry.enabled ? "基线可用" : "需申请"} · ${tool.name}`).join("\n")}`,
					)
					.join("\n\n"),
			),
		);
		return;
	}
	if (choice === "清空 MCP 临时授权") {
		if ((await pick("撤销全部 MCP 临时授权并断开临时连接？", ["撤销并断开", "取消"])) === "撤销并断开")
			await access.revoke();
		return;
	}
	const candidates = access.list().filter(entry => !entry.enabled);
	const selected = await pick("选择已登记服务", [...candidates.map(entry => entry.name), "返回"]);
	if (!selected || selected === "返回") return;
	if (choice === "撤销指定服务授权") {
		if ((await pick(`撤销 ${selected} 的授权并断开临时连接？`, ["撤销并断开", "取消"])) === "撤销并断开")
			await access.revoke(selected);
		return;
	}
	await access.discover(selected, "用户检查 MCP 工具目录", signal);
	guard();
	const tools = access.list().find(entry => entry.name === selected)?.tools ?? [];
	const tool = await pick("选择临时启用的一个工具", [...tools.map(item => item.name), "返回"]);
	if (!tool || tool === "返回") return;
	if (
		(await pick(`临时启用 ${selected}/${tool}\n其它工具不随之启用，mcp_call 工具权限仍独立。\n${lifetime}`, [
			"本次Agent运行有效",
			"取消",
		])) === "本次Agent运行有效"
	) {
		await access.grant(selected, tool, signal);
		ui.notify(`已临时启用 ${selected}/${tool}。`, "info");
	}
}
