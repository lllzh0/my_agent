import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "../config/config";
import { changePreview } from "../changes/preview";
import { discoverExternalSkills } from "../skills/external";
import { PRODUCT_TOOL_NAMES } from "../runtime/tool-catalog";
import { contained } from "../policy/paths";
import type { PresetDefinition, PresetPath } from "./presets";
import { checkPresetDraft, presetBaseConfig, savePresetDraft, type PresetDraft } from "./store";

/** This port has no terminal or OS assumptions; adapters own display and input. */
export interface PresetEditorUI {
	select(title: string, choices: string[]): Promise<string | undefined>;
	input(title: string, initial?: string): Promise<string | undefined>;
	preview(title: string, body: string): Promise<void>;
	notify(message: string): void;
}

async function chooseMany(
	title: string,
	options: string[],
	initial: string[],
	ui: PresetEditorUI,
): Promise<string[] | undefined> {
	const selected = new Set(initial);
	for (;;) {
		const labels = options.map((item, i) => `${i + 1}. ${selected.has(item) ? "已选" : "未选"} · ${item}`);
		const choice = await ui.select(`${title} · 已选 ${selected.size} 项`, [
			...labels,
			"采用本次选择",
			"取消本项修改",
		]);
		if (!choice || choice === "取消本项修改") return;
		if (choice === "采用本次选择") return [...selected];
		const index = labels.indexOf(choice);
		if (index >= 0) {
			const item = options[index];
			if (selected.has(item)) selected.delete(item);
			else selected.add(item);
		}
	}
}

function reference(file: string, cwd: string): PresetPath {
	const absolute = path.resolve(cwd, file);
	const relative = path.relative(cwd, absolute);
	return contained(cwd, absolute)
		? { base: "workspace", path: relative.split(path.sep).join("/") || "." }
		: { base: "absolute", path: absolute };
}

async function skillPaths(home: string, file: string): Promise<string[]> {
	if ((await fs.stat(file)).isFile()) return [file];
	const found = await discoverExternalSkills({ home, roots: [{ label: "明确选择的技能目录", path: file }] });
	if (found.truncated || found.diagnostics.length)
		throw new Error("技能扫描不完整；请选择更小的目录或直接指定 SKILL.md。原选择保持不变。");
	return found.candidates.map(candidate => path.join(candidate.directory, "SKILL.md"));
}

async function resourceSelection(
	home: string,
	cwd: string,
	kind: keyof PresetDefinition["resources"],
	definition: PresetDefinition,
	base: Config,
	ui: PresetEditorUI,
): Promise<void> {
	const entries = new Map<string, PresetPath>();
	const add = (entry: PresetPath) => entries.set(`${entry.base}: ${entry.path}`, entry);
	for (const entry of definition.resources[kind]) add(entry);
	for (const configured of base.resources[kind]) {
		if (kind === "skills") {
			try {
				for (const file of await skillPaths(home, path.resolve(cwd, configured))) add(reference(file, cwd));
			} catch {
				ui.notify(`技能候选暂不可扫描：${configured}；可以直接添加 SKILL.md。`);
			}
		} else add(reference(configured, cwd));
	}
	for (;;) {
		const action = await ui.select("资源候选仅来自已配置或主动选择的路径", [
			"勾选资源",
			"添加文件或技能目录",
			"取消本项修改",
		]);
		if (!action || action === "取消本项修改") return;
		if (action === "添加文件或技能目录") {
			const input = await ui.input(
				kind === "skills" ? "技能文件或目录路径（扫描后逐个勾选）" : "指令或附加提示词文件路径",
			);
			if (!input?.trim()) continue;
			const absolute = path.resolve(cwd, input.trim());
			const files = kind === "skills" ? await skillPaths(home, absolute) : [absolute];
			for (const file of files) add(reference(file, cwd));
		}
		const initial = definition.resources[kind].map(entry => `${entry.base}: ${entry.path}`);
		const selected = await chooseMany("选择资源（新增候选默认不勾选）", [...entries.keys()], initial, ui);
		if (selected) definition.resources[kind] = selected.map(key => entries.get(key)!);
		return;
	}
}

async function permissionRoots(
	label: string,
	roots: string[],
	cwd: string,
	ui: PresetEditorUI,
): Promise<string[] | undefined> {
	const draft = [...roots];
	for (;;) {
		const choice = await ui.select(label, [
			"添加目录",
			...draft.map((item, i) => `${i + 1}. 移除 · ${item}`),
			"采用目录列表",
			"取消本项修改",
		]);
		if (!choice || choice === "取消本项修改") return;
		if (choice === "采用目录列表") return draft;
		if (choice === "添加目录") {
			const input = await ui.input("目录路径");
			if (!input?.trim()) continue;
			const directory = await fs.realpath(path.resolve(cwd, input.trim()));
			if (!(await fs.stat(directory)).isDirectory()) throw new Error("请选择目录");
			if (!draft.includes(directory)) draft.push(directory);
		} else {
			const index = draft.findIndex((item, i) => choice === `${i + 1}. 移除 · ${item}`);
			if (index >= 0) draft.splice(index, 1);
		}
	}
}

async function editPermissions(
	definition: PresetDefinition,
	base: Config,
	cwd: string,
	ui: PresetEditorUI,
): Promise<void> {
	const permissions = structuredClone(definition.permissions ?? base.permissions);
	for (;;) {
		const choice = await ui.select("权限草稿（不保存 full 或临时授权）", [
			"读取目录",
			"写入目录",
			"联网开关",
			"审批方式",
			"沿用共享权限",
			"采用权限草稿",
			"取消本项修改",
		]);
		if (!choice || choice === "取消本项修改") return;
		if (choice === "沿用共享权限") {
			delete definition.permissions;
			return;
		}
		if (choice === "采用权限草稿") {
			definition.permissions = permissions;
			return;
		}
		if (choice === "读取目录" || choice === "写入目录") {
			const key = choice === "读取目录" ? "readRoots" : "writeRoots";
			const selected = await permissionRoots(choice, permissions[key], cwd, ui);
			if (selected) permissions[key] = selected;
		} else if (choice === "联网开关") {
			const selected = await ui.select("联网范围仍受共享域名列表限制", ["允许受控联网", "禁止联网", "返回"]);
			if (selected && selected !== "返回") permissions.allowNetwork = selected === "允许受控联网";
		} else {
			const selected = await ui.select("持久审批方式", ["manual", "auto", "返回"]);
			if (selected === "manual" || selected === "auto") permissions.approval = selected;
		}
	}
}

/** Saving changes only the definition on disk. No active state is accepted here. */
export async function editPreset(
	home: string,
	cwd: string,
	source: PresetDraft,
	ui: PresetEditorUI,
	beforeSave: () => void = () => {},
): Promise<boolean> {
	const draft = structuredClone(source);
	const definition = draft.definition;
	const base = await presetBaseConfig(home);
	for (;;) {
		const choice = await ui.select(`编辑预设 ${draft.id} · 保存后下次启动生效`, [
			"显示名称",
			"运行模式",
			"指令文件",
			"技能",
			"附加提示词",
			"工具",
			"模型连接",
			"MCP 服务",
			"权限范围",
			"检查草稿",
			"预览并保存",
			"放弃编辑",
		]);
		if (!choice || choice === "放弃编辑") return false;
		try {
			if (choice === "显示名称") {
				const name = await ui.input("预设显示名称", definition.name);
				if (name !== undefined) definition.name = name;
			} else if (choice === "运行模式") {
				const mode = await ui.select("切换为纯聊天会清空本草稿的资源、工具和 MCP", ["agent", "chat", "返回"]);
				if (mode === "agent" || mode === "chat") {
					definition.mode = mode;
					if (mode === "chat") {
						definition.resources = { instructions: [], skills: [], appendSystem: [] };
						definition.tools = [];
						definition.mcpServers = [];
					}
				}
			} else if (["指令文件", "技能", "附加提示词"].includes(choice)) {
				await resourceSelection(
					home,
					cwd,
					choice === "技能" ? "skills" : choice === "指令文件" ? "instructions" : "appendSystem",
					definition,
					base,
					ui,
				);
			} else if (choice === "工具") {
				const selected = await chooseMany(
					"工具（bash 需 job_output/job_stop；技能需 read）",
					[...PRODUCT_TOOL_NAMES],
					definition.tools,
					ui,
				);
				if (selected) definition.tools = selected;
			} else if (choice === "模型连接") {
				const keys = [base.model, ...(base.models ?? [])].map(
					model => model.key ?? `${model.provider}/${model.id}`,
				);
				const selected = await chooseMany(
					"候选连接（只保存 key，不保存凭据）",
					keys,
					definition.model?.allowed ?? [keys[0]],
					ui,
				);
				if (selected) {
					if (!selected.length) throw new Error("至少选择一个模型连接");
					const preferred = await ui.select("默认模型连接", selected);
					if (preferred) definition.model = { default: preferred, allowed: selected };
				}
			} else if (choice === "MCP 服务") {
				const selected = await chooseMany(
					"MCP 服务（仍须授权；请同时选择对应 MCP 工具）",
					Object.keys(base.mcpServers),
					definition.mcpServers,
					ui,
				);
				if (selected) definition.mcpServers = selected;
			} else if (choice === "权限范围") await editPermissions(definition, base, cwd, ui);
			else if (choice === "检查草稿") {
				await checkPresetDraft(home, cwd, draft);
				ui.notify("草稿与引用检查通过；没有连接模型或 MCP，也没有保存。");
			} else if (choice === "预览并保存") {
				await checkPresetDraft(home, cwd, draft);
				const before =
					source.expected === undefined ? null : `${JSON.stringify(JSON.parse(source.expected), null, 2)}\n`;
				const preview = changePreview("preset.json", before, `${JSON.stringify(definition, null, 2)}\n`);
				await ui.preview(
					"预设差异 · 返回后仍需确认保存",
					`${preview.diff}${preview.previewTruncated ? "\n预览已截断。" : ""}`,
				);
				if (
					(await ui.select("保存预设？当前会话不变；旧会话恢复仍校验原清单", ["确认保存", "继续编辑"])) !==
					"确认保存"
				)
					continue;
				beforeSave();
				await savePresetDraft(home, cwd, draft);
				ui.notify("预设已保存；当前会话不变，下次启动生效。");
				return true;
			}
		} catch (error) {
			ui.notify(error instanceof Error ? error.message : String(error));
		}
	}
}
