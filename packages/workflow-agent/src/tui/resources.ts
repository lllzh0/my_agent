import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import type { RunState } from "../runtime/state";
import { skillImportFromMenu } from "./skill-import";

export async function resourcesFromCommand(state: RunState, ctx: ExtensionContext, args = ""): Promise<void> {
	const live = state.liveResources;
	if (!live) throw new Error("资源管理尚未初始化。");
	if (args === "list") {
		await ctx.ui.editor(
			"当前资源开关",
			replaceTabs(
				JSON.stringify(
					{
						resources: live.list(),
						note: "enabled 为用户选择，active 为当前可用；goal 仍受目标模式限制。开关保存在配置中，后续请求生效；已有聊天内容保留。",
					},
					null,
					2,
				),
			),
		);
		return;
	}
	const match = /^(on|off)\s+([\s\S]+)$/.exec(args);
	if (match) {
		await live.setEnabled(match[2], match[1] === "on", ctx.signal);
		ctx.ui.notify("资源开关已保存并生效；已有聊天内容保留。", "info");
		return;
	}
	if (args === "reload") {
		await live.apply(state.config, ctx.signal);
		ctx.ui.notify("已重新读取所选资源，后续请求使用新内容；已有聊天内容保留。", "info");
		return;
	}
	if (args) throw new Error("用法：/resources [list|on <ID>|off <ID>|reload]");
	if (!ctx.hasUI) throw new Error("非交互模式请使用 /resources list、on、off 或 reload。");
	while (true) {
		const choice = await ctx.ui.select("资源开关 · 空闲时立即生效并保存", [
			"查看当前状态",
			"工具",
			"技能",
			"指令文件",
			"附加提示词",
			"添加指令文件",
			"添加技能文件或目录",
			"导入外部技能",
			"添加附加提示词",
			"重新读取所选资源",
			"返回",
		]);
		ctx.signal?.throwIfAborted();
		if (!choice || choice === "返回") return;
		if (choice === "导入外部技能") await skillImportFromMenu(state, ctx);
		else if (choice === "查看当前状态") await resourcesFromCommand(state, ctx, "list");
		else if (choice === "重新读取所选资源") await resourcesFromCommand(state, ctx, "reload");
		else if (choice.startsWith("添加")) {
			const input = await ctx.ui.input("本地路径");
			if (!input?.trim()) continue;
			const file = path.resolve(state.cwd, input.trim());
			const next = structuredClone(state.config);
			const selected =
				choice === "添加指令文件"
					? next.resources.instructions
					: choice === "添加技能文件或目录"
						? next.resources.skills
						: next.resources.appendSystem;
			if (!selected.includes(file)) selected.push(file);
			await live.apply(next, ctx.signal);
			ctx.ui.notify("资源已添加并生效。", "info");
		} else {
			const kind = { 工具: "tool", 技能: "skill", 指令文件: "instruction", 附加提示词: "system" }[choice];
			const entries = live.list().filter(item => item.kind === kind);
			if (!entries.length) {
				ctx.ui.notify("此类没有已配置资源。", "info");
				continue;
			}
			const labels = entries.map(item => replaceTabs(`${item.enabled ? "开" : "关"} · ${item.name}`));
			const selected = await ctx.ui.select("选择要开关的资源；聊天中已有内容不会删除", labels);
			const entry = selected === undefined ? undefined : entries[labels.indexOf(selected)];
			if (entry) {
				await live.setEnabled(entry.id, !entry.enabled, ctx.signal);
				ctx.ui.notify("资源开关已保存并生效。", "info");
			}
		}
	}
}
