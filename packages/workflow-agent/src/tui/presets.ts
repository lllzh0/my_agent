import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RunState } from "../runtime/state";
import { editPreset, type PresetEditorUI } from "../presets/editor";
import { copyPresetDraft, listPresets, newPresetDraft, openPresetDraft } from "../presets/store";
import { presetCommand } from "../presets/cli";
import { presetDefaults, setPresetDefault } from "../presets/defaults";
import { InkDocument } from "./ink-document";

export async function presetFromCommand(
	state: RunState,
	ctx: ExtensionContext,
	args: string,
	ensureIdle: () => void,
	showCurrent: () => Promise<void>,
): Promise<void> {
	if (!ctx.hasUI) {
		if (!args || args === "show") return showCurrent();
		throw new Error("预设草稿编辑需要交互终端；命令行可使用 agent preset list/create/copy/show/check/bind/default。");
	}
	const clean = (value: string) => replaceTabs(sanitizeText(value));
	const ui: PresetEditorUI = {
		async select(title, choices) {
			ctx.signal?.throwIfAborted();
			const labels = choices.map(clean);
			const choice = await ctx.ui.select(clean(title), labels);
			return choice === undefined ? undefined : choices[labels.indexOf(choice)];
		},
		async input(title, initial) {
			const value = await ctx.ui.input(
				clean(initial ? `${title}（留空保持原值）` : title),
				initial && clean(initial),
			);
			return value === "" && initial ? initial : value;
		},
		async preview(title, body) {
			await ctx.ui.custom<void>(
				(tui, _theme, _keys, done) =>
					new InkDocument(
						clean(title),
						clean(body),
						() => Math.max(5, tui.terminal.rows - 2),
						() => done(),
					),
				{
					overlay: true,
					overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", margin: 1, mouseTracking: false },
					signal: ctx.signal,
				},
			);
		},
		notify(message) {
			ctx.ui.notify(clean(message), "info");
		},
	};
	const pick = async () => {
		const items = await listPresets(state.home);
		const labels = items.map(item => `${item.id} · ${item.name ?? "无效清单"} · ${item.status}`);
		const selected = await ui.select("选择预设（不切换当前会话）", labels);
		return selected === undefined ? undefined : items[labels.indexOf(selected)]?.id;
	};
	const words = args.trim().split(/\s+/).filter(Boolean);
	let action: string | undefined = words[0];
	let id: string | undefined = words[1];
	let target: string | undefined = words[2];
	if (words.length > 3) throw new Error("预设命令参数过多");
	if (target && !["copy", "clone"].includes(action ?? "")) throw new Error("只有 copy/clone 接受来源和新 ID 两个参数");
	if (action === "use") throw new Error("运行中切换尚未开放；请退出后使用 --preset，或先设置下次启动默认。");
	if (!action) {
		const choices = [
			"当前预设与实际资源",
			"查看清单与引用",
			"创建预设",
			"编辑预设",
			"复制预设",
			"绑定当前工作区",
			"解除工作区绑定",
			"设置全局默认",
			"清除全局默认",
			"查看启动默认",
			"返回",
		];
		const chosen = await ui.select("预设管理 · 修改只影响下次启动", choices);
		if (!chosen || chosen === "返回") return;
		if (chosen === "当前预设与实际资源") return showCurrent();
		action = (
			{
				查看清单与引用: "show",
				创建预设: "create",
				编辑预设: "edit",
				复制预设: "copy",
				绑定当前工作区: "bind",
				解除工作区绑定: "unbind",
				设置全局默认: "default",
				清除全局默认: "clear-default",
				查看启动默认: "defaults",
			} as Record<string, string>
		)[chosen];
	}
	if (action === "defaults")
		return ui.preview(
			"后续启动默认（当前会话不变）",
			JSON.stringify(await presetDefaults(state.home, state.cwd), null, 2),
		);
	if (action === "show" || action === "check") {
		if (action === "show" && args.trim() === "show") return showCurrent();
		id ??= await pick();
		if (!id) return;
		await ui.preview(
			"磁盘清单与引用（不代表当前已加载）",
			JSON.stringify(await presetCommand(state.home, state.cwd, [action, id]), null, 2),
		);
		return;
	}
	ensureIdle();
	if (["unbind", "clear-default"].includes(action)) {
		if (id) throw new Error("解除默认不接受预设 ID");
		await setPresetDefault(state.home, state.cwd, action === "unbind" ? "workspace" : "global");
		ui.notify("默认选择已解除；当前会话保持不变。");
		return;
	}
	if (action === "bind" || action === "default") {
		id ??= await pick();
		if (!id) return;
		ensureIdle();
		await setPresetDefault(state.home, state.cwd, action === "bind" ? "workspace" : "global", id);
		ui.notify(`已设置下次启动默认：${id}；当前会话保持不变。`);
		return;
	}
	if (action === "create") {
		id ??= await ui.input("新预设 ID");
		if (!id) return;
		const template = await ui.select("选择起始模板（不会自动启用资源）", ["coding", "research", "chat", "bare"]);
		if (template) await editPreset(state.home, state.cwd, newPresetDraft(id, template), ui, ensureIdle);
		return;
	}
	id ??= await pick();
	if (!id) return;
	if (action === "edit")
		await editPreset(state.home, state.cwd, await openPresetDraft(state.home, id), ui, ensureIdle);
	else if (action === "copy" || action === "clone") {
		target ??= await ui.input("复制到新的预设 ID（仅复制定义与资源引用）");
		if (target)
			await editPreset(
				state.home,
				state.cwd,
				await copyPresetDraft(state.home, state.cwd, id, target),
				ui,
				ensureIdle,
			);
	} else throw new Error("用法：/preset [show|check|create|edit|copy|bind|unbind|default|defaults] [ID] [新 ID]");
}
