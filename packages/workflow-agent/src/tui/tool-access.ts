import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RunState } from "../runtime/state";
import type { ToolAccessRequest, ToolAccessDecision } from "../runtime/temporary-tools";
import { redact } from "../storage";
import { InkDocument } from "./ink-document";
import { formatPreviewText } from "./operation-preview";

const limits = "目录、联网和计划模式仍受原规则限制；具体操作仍照原有规则审批。";
const lifetime = "临时授权只保留在本次Agent运行中；退出、重启或切换预设后清空。";
const cleanup = "撤销运行期授权不影响已有任务收尾；收尾权限仅限关联任务。";

function toolStatus(entry: { enabled: boolean; temporary: boolean; scoped?: boolean }): string {
	return entry.enabled ? "基线启用" : entry.temporary ? "临时启用" : entry.scoped ? "任务收尾（仅关联任务）" : "关闭";
}

function singleLine(value: string): string {
	return truncateToWidth(formatPreviewText(value.replace(/[\r\n]+/g, " "), 1), TRUNCATE_LENGTHS.LINE);
}

/** Capability decisions are separate from approval of a particular operation. */
export async function chooseToolAccess(
	request: ToolAccessRequest,
	select: (title: string, choices: string[]) => Promise<string | undefined>,
	inspect: (body: string) => Promise<void>,
): Promise<ToolAccessDecision> {
	const value = structuredClone(request);
	const parameters = JSON.stringify(
		redact(value.arguments),
		(_key, entry: unknown) => (typeof entry === "string" ? sanitizeText(entry) : entry),
		2,
	);
	const reason = formatPreviewText(value.reason, PREVIEW_LIMITS.EXPANDED_LINES)
		.split("\n")
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LONG))
		.join("\n");
	const summary = [
		`临时工具申请 · ${singleLine(value.tool)}`,
		limits,
		lifetime,
		"仅此次调用只允许下面这笔调用；本次Agent运行有效会允许后续调用这个工具。",
		`申请理由：${reason}`,
	].join("\n");
	const body = formatPreviewText(`${summary}\n\n具体调用参数：\n${parameters}`);
	const title = formatPreviewText(body, PREVIEW_LIMITS.EXPANDED_LINES);
	while (true) {
		const choice = await select(title, ["仅此次调用", "本次Agent运行有效", "拒绝", "查看申请详情（只读）"]);
		if (choice === "查看申请详情（只读）") {
			await inspect(body);
			continue;
		}
		return choice === "本次Agent运行有效" ? "run" : choice === "仅此次调用" ? "once" : "deny";
	}
}

export async function toolsFromCommand(
	state: RunState,
	ctx: ExtensionContext,
	args: string,
	ensureIdle: () => void,
): Promise<void> {
	const access = state.toolAccess;
	if (!access) throw new Error("临时工具授权尚未初始化。");
	const input = args.trim();
	const guard = () => {
		ctx.signal?.throwIfAborted();
		ensureIdle();
		ctx.signal?.throwIfAborted();
	};
	const select = async (title: string, choices: string[]) => {
		guard();
		const choice = await ctx.ui.select(title, choices, { signal: ctx.signal });
		guard();
		return choice;
	};
	const showStatus = async () => {
		ctx.signal?.throwIfAborted();
		const entries = access.list();
		const body = formatPreviewText(
			[
				"工具状态 · 只读",
				limits,
				lifetime,
				"同一预设中开启新对话或恢复对话会保留临时授权。",
				"基线启用来自预设或资源选择；撤销临时授权不会关闭基线工具。",
				cleanup,
				"",
				...entries.map(entry => `${toolStatus(entry)} · ${singleLine(entry.name)} · ${singleLine(entry.label)}`),
				"",
				"/tools allow <名称>：启用到本次Agent运行结束；单次授权需要有具体调用的申请。",
				"/tools revoke <名称>：撤销该工具的临时授权；/tools clear：撤销全部临时授权。",
			].join("\n"),
		);
		if (!ctx.hasUI) {
			await ctx.ui.editor("工具状态 · 只读", body);
			return;
		}
		await ctx.ui.custom<void>(
			(tui, _theme, _keys, done) =>
				new InkDocument(
					"工具状态 · 只读",
					body,
					() => Math.max(5, tui.terminal.rows - 2),
					() => done(),
				),
			{
				overlay: true,
				overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", margin: 1, mouseTracking: false },
				signal: ctx.signal,
			},
		);
	};
	if (input === "list" || (!input && !ctx.hasUI)) return showStatus();
	if (!ctx.hasUI) throw new Error("工具授权管理需要人工交互终端；非交互模式可用 /tools 或 /tools list 查看状态。");
	const change = async (operation: "allow" | "revoke", name: string) => {
		const entry = access.list().find(item => item.name === name);
		if (!entry) throw new Error(`工具 ${singleLine(name)} 不在可临时授权的工具清单中。`);
		const label = singleLine(`${entry.label} (${entry.name})`);
		if (operation === "allow") {
			const choice = await select(`临时启用 ${label}\n${limits}\n${lifetime}`, ["本次Agent运行有效", "取消"]);
			if (choice !== "本次Agent运行有效") return;
			access.grant(name);
			ctx.ui.notify(`已临时启用 ${label}。${lifetime}${limits}`, "info");
		} else {
			const choice = await select(
				`撤销 ${label} 的临时授权${entry.enabled ? "\n此工具基线仍启用，撤销后仍可用。" : ""}`,
				["撤销临时授权", "取消"],
			);
			if (choice !== "撤销临时授权") return;
			access.revoke(name);
			const current = access.list().find(item => item.name === name);
			ctx.ui.notify(
				`已撤销 ${label} 的临时授权。当前状态：${current ? toolStatus(current) : "关闭"}。${cleanup}`,
				"info",
			);
		}
	};
	const clear = async () => {
		const choice = await select(`撤销全部临时工具授权；基线启用的工具保持可用。\n${cleanup}`, [
			"撤销全部临时授权",
			"取消",
		]);
		if (choice !== "撤销全部临时授权") return;
		access.revoke();
		ctx.ui.notify(`已撤销全部临时工具授权；基线启用的工具仍可按原规则使用。${cleanup}`, "info");
	};
	const match = /^(allow|revoke)\s+(\S+)$/.exec(input);
	if (match) return change(match[1] as "allow" | "revoke", match[2]);
	if (input === "clear") return clear();
	if (input) throw new Error("用法：/tools [list|allow <名称>|revoke <名称>|clear]");
	while (true) {
		const choice = await select(`临时工具授权\n${limits}\n${lifetime}`, [
			"查看工具状态",
			"临时启用工具",
			"撤销临时授权",
			"清空临时授权",
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice === "查看工具状态") await showStatus();
		else if (choice === "清空临时授权") await clear();
		else if (choice === "临时启用工具" || choice === "撤销临时授权") {
			const entries = access
				.list()
				.filter(entry => (choice === "临时启用工具" ? !entry.enabled && !entry.temporary : entry.temporary));
			if (!entries.length) {
				ctx.ui.notify(choice === "临时启用工具" ? "没有关闭的可申请工具。" : "当前没有临时工具授权。", "info");
				continue;
			}
			const labels = entries.map(entry => singleLine(`${entry.label} (${entry.name}) · ${toolStatus(entry)}`));
			const selected = await select("选择工具", [...labels, "返回"]);
			const entry = selected === undefined ? undefined : entries[labels.indexOf(selected)];
			if (entry) await change(choice === "临时启用工具" ? "allow" : "revoke", entry.name);
		}
	}
}
