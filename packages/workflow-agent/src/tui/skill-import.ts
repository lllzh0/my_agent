import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { RunState } from "../runtime/state";
import {
	discoverExternalSkills,
	externalSkillRoots,
	importExternalSkills,
	type ExternalSkillRoot,
} from "../skills/external";

function display(text: string): string {
	// External skill metadata and paths are untrusted terminal text.
	return truncateToWidth(replaceTabs(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").replaceAll("\n", " ")), 120);
}

export async function skillImportFromMenu(state: RunState, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) throw new Error("导入外部技能需要交互终端；请打开 /resources 菜单。");
	const choice = await ctx.ui.select("选择扫描来源；扫描只读取目录，不会启用技能", [
		"常见来源（用户和项目）",
		"自定义目录",
		"取消",
	]);
	ctx.signal?.throwIfAborted();
	if (!choice || choice === "取消") return;
	let roots: ExternalSkillRoot[];
	if (choice === "自定义目录") {
		const input = await ctx.ui.input("技能来源目录（可含多个技能子目录）");
		if (!input?.trim()) return;
		roots = [{ label: "自定义", path: path.resolve(state.cwd, input.trim()) }];
	} else {
		const all = externalSkillRoots(os.homedir(), state.cwd);
		const labels = all.map((root, index) =>
			display(`${index + 1}. ${root.label} · ${root.path.replace(os.homedir(), "~")}`),
		);
		const source = await ctx.ui.select("选择来源目录", ["全部常见来源", ...labels, "取消"]);
		if (!source || source === "取消") return;
		roots = source === "全部常见来源" ? all : [all[labels.indexOf(source)]];
	}
	const discovery = await discoverExternalSkills({ home: os.homedir(), roots, signal: ctx.signal });
	if (discovery.diagnostics.length || discovery.truncated)
		await ctx.ui.editor(
			"扫描说明 · 未扫描或无效的项目不会自动启用",
			JSON.stringify({ truncated: discovery.truncated, diagnostics: discovery.diagnostics }, null, 2),
		);
	if (!discovery.candidates.length) {
		ctx.ui.notify("没有找到可导入的有效技能；原有资源选择保持不变。", "info");
		return;
	}
	const selected = new Set<string>();
	while (true) {
		const labels = discovery.candidates.map((candidate, index) =>
			display(
				`${index + 1}. ${selected.has(candidate.id) ? "取消" : "选"} · ${candidate.name} · ${candidate.directory}`,
			),
		);
		const item = await ctx.ui.select(`逐个选择技能 · 已选 ${selected.size} 个；默认不勾选`, [
			...labels,
			"查看技能说明",
			"预览并继续",
			"取消导入",
		]);
		ctx.signal?.throwIfAborted();
		if (!item || item === "取消导入") return;
		if (item === "查看技能说明") {
			await ctx.ui.editor("来源技能说明", JSON.stringify(discovery.candidates, null, 2));
			continue;
		}
		if (item === "预览并继续") {
			if (selected.size) break;
			ctx.ui.notify("请先选择至少一个技能。", "info");
			continue;
		}
		const candidate = discovery.candidates[labels.indexOf(item)];
		if (candidate) {
			if (selected.has(candidate.id)) selected.delete(candidate.id);
			else selected.add(candidate.id);
		}
	}
	await ctx.ui.editor(
		"导入预览 · 所选技能会加入资源并启用；同目录或同名冲突将跳过",
		JSON.stringify(
			{
				target: path.join(state.home, "skills"),
				selected: discovery.candidates.filter(candidate => selected.has(candidate.id)),
				note: "复制保留独立副本；软链接持续读取来源。可在资源菜单关闭导入技能。",
			},
			null,
			2,
		),
	);
	const mode = await ctx.ui.select("选择导入方式", ["复制（推荐）", "软链接（跟随来源变化）", "取消导入"]);
	if (!mode || mode === "取消导入") return;
	const confirm = await ctx.ui.select("确认本次所选技能和方式", ["导入并启用", "取消导入"]);
	if (confirm !== "导入并启用") return;
	const result = await importExternalSkills(
		state,
		discovery,
		[...selected],
		mode === "复制（推荐）" ? "copy" : "link",
		ctx.signal,
	);
	await ctx.ui.editor("本次技能导入结果", JSON.stringify(result, null, 2));
	const imported = result.results.filter(item => item.status === "imported").length;
	const skipped = result.results.filter(item => item.status === "skipped").length;
	const failed = result.results.filter(item => item.status === "failed").length;
	ctx.ui.notify(
		`技能导入：已启用 ${imported}，跳过 ${skipped}，失败 ${failed}。可在资源菜单查看或开关。`,
		failed ? "warning" : "info",
	);
}
