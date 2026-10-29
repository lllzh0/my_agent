import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RunState } from "../runtime/state";
import { editPreset, type PresetEditorUI } from "../presets/editor";
import { copyPresetDraft, listPresets, newPresetDraft, openPresetDraft } from "../presets/store";
import { presetCommand } from "../presets/cli";
import { presetDefaults, setPresetDefault } from "../presets/defaults";
import { InkDocument } from "./ink-document";
import { presetHistory } from "../presets/history";
import { readPreset, samePreset, resolvePreset } from "../presets/presets";
import { presetBaseConfig } from "../presets/store";
import { requestPresetTransition } from "./preset-transition";
import { loadResources } from "../runtime/resources";

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
		const selected = await ui.select("选择预设", labels);
		return selected === undefined ? undefined : items[labels.indexOf(selected)]?.id;
	};
	const words = args.trim().split(/\s+/).filter(Boolean);
	let action: string | undefined = words[0];
	let id: string | undefined = words[1];
	let target: string | undefined = words[2];
	if (words.length > 3) throw new Error("预设命令参数过多");
	if (target && !["copy", "clone", "use"].includes(action ?? ""))
		throw new Error("只有 copy/clone 或 use 接受第三个参数");
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
			"切换预设",
			"返回",
		];
		const chosen = await ui.select("预设管理 · 编辑保存与会话切换", choices);
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
				切换预设: "use",
			} as Record<string, string>
		)[chosen];
	}
	if (action === "use") {
		ensureIdle();
		if (!state.handoff) throw new Error("预设交接需要从产品 launcher 的交互终端启动。");
		if (target && target !== "--new") throw new Error("用法：/preset use ID [--new]");
		id ??= await pick();
		if (!id) return;
		if (id !== "legacy") await readPreset(state.home, id);
		let changed = false;
		if (id === (state.preset?.id ?? "legacy") && !target) {
			const compiled =
				id === "legacy"
					? undefined
					: await resolvePreset(state.home, state.cwd, id, await presetBaseConfig(state.home));
			const resources = compiled ? await loadResources(compiled.config, state.cwd, compiled.light) : state.resources;
			if (samePreset(state.preset, compiled?.identity) && resources.signature === state.resources.signature) {
				ui.notify("已在此预设；可加 --new 新建独立会话。");
				return;
			}
			changed = true;
			await ui.preview(
				"磁盘定义已改变，只能新建（当前生效快照保留）",
				JSON.stringify(
					{
						currentResources: state.resources.entries,
						next: await readPreset(state.home, id),
					},
					null,
					2,
				),
			);
		}
		const histories = target || changed ? [] : await presetHistory(state.home, state.cwd, id, state.sessionId);
		let resume: string | undefined;
		const labels = histories.map(info => `恢复 ${info.id} · ${info.title ?? info.firstMessage.slice(0, 60)}`);
		if (histories.length || changed) {
			const selected = await ui.select("切换到独立运行环境", ["新建会话", ...labels, "取消"]);
			if (!selected || selected === "取消") return;
			if (selected !== "新建会话") resume = histories[labels.indexOf(selected)]?.path;
		}
		ensureIdle();
		requestPresetTransition(state, ctx, { preset: id, resume });
		return;
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
