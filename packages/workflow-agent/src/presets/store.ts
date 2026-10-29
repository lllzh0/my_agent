import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "../config/config";
import { atomicJson, readJson, record } from "../storage";
import { BARE_TOOL_NAMES } from "../runtime/tool-catalog";
import { contained } from "../policy/paths";
import {
	builtinPreset,
	compilePreset,
	presetId,
	presetResourcePath,
	readPreset,
	validatePreset,
	type PresetDefinition,
} from "./presets";

export interface PresetDraft {
	id: string;
	definition: PresetDefinition;
	expected?: string;
}
export interface PresetListItem {
	id: string;
	name?: string;
	status: "builtin" | "configured" | "invalid";
}

export function newPresetDraft(id: string, template = "coding"): PresetDraft {
	presetId(id);
	if (["legacy", "chat", "bare"].includes(id)) throw new Error("内置预设只读，请复制到新的 ID");
	if (!["coding", "research", "chat", "bare"].includes(template)) throw new Error("未知预设模板");
	const definition = { ...builtinPreset(template === "chat" ? "chat" : "bare"), id, name: id };
	if (template === "research")
		definition.tools = BARE_TOOL_NAMES.filter(
			name => !["bash", "job_output", "job_stop", "write", "edit", "goal"].includes(name),
		);
	return { id, definition };
}

export async function openPresetDraft(home: string, id: string): Promise<PresetDraft> {
	if (["legacy", "chat", "bare"].includes(id)) throw new Error("内置预设只读，请复制到新的 ID");
	const definition = await readPreset(home, id);
	return { id, definition, expected: JSON.stringify(definition) };
}

/** Deliberately lightweight: management must not import the SDK or contact services. */
export async function presetBaseConfig(home: string): Promise<Config> {
	const source = record(
		await readJson(path.join(home, "config.json")),
		"请先运行 agent setup --defaults 创建共享配置",
	);
	if (source.version !== 1 || !source.model || !source.permissions || !source.mcpServers)
		throw new Error("基础配置无效，请先运行 doctor 检查 config.json");
	return source as unknown as Config;
}

export async function checkPresetDraft(home: string, cwd: string, draft: PresetDraft): Promise<void> {
	const definition = validatePreset(draft.definition);
	if (definition.id !== draft.id) throw new Error("编辑时不能更改预设 ID，请使用复制");
	if ((await readJson(path.join(home, "config.json"))) === undefined) {
		if (
			definition.model ||
			definition.mcpServers.length ||
			Object.values(definition.resources).some(items => items.length)
		)
			throw new Error("请先运行 agent setup --defaults，再检查资源和连接引用");
		return;
	}
	await compilePreset(home, cwd, definition, await presetBaseConfig(home));
}

/** Guard user-owned records; project files are never a destination for defaults. */
export async function presetStoragePath(home: string, parts: string[]): Promise<string> {
	await fs.mkdir(home, { recursive: true, mode: 0o700 });
	const root = await fs.realpath(home);
	let directory = root;
	for (const part of parts.slice(0, -1)) {
		const next = path.join(directory, part);
		await fs.mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		directory = await fs.realpath(next);
		if (!contained(root, directory)) throw new Error("预设存储目录超出配置目录");
	}
	const file = path.join(directory, parts.at(-1)!);
	try {
		if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("预设记录不能是符号链接");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return file;
}

export async function savePresetDraft(home: string, cwd: string, draft: PresetDraft): Promise<void> {
	newPresetDraft(draft.id);
	await checkPresetDraft(home, cwd, draft);
	if (draft.expected === undefined) {
		try {
			await fs.lstat(path.join(home, "presets", draft.id));
			throw new Error("同名预设或目录已存在，请使用新的 ID");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const file = await presetStoragePath(home, ["presets", draft.id, "preset.json"]);
	let lock: fs.FileHandle;
	try {
		lock = await fs.open(`${file}.lock`, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error("另一个编辑器正在保存；请稍后重开草稿，勿覆盖原文件");
		throw error;
	}
	try {
		const current = await readJson(file);
		if ((current === undefined ? undefined : JSON.stringify(validatePreset(current))) !== draft.expected)
			throw new Error("预设已被外部修改或同名预设已存在；请重新打开草稿");
		if (draft.expected === undefined)
			await fs.writeFile(file, `${JSON.stringify(draft.definition, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		else await atomicJson(file, draft.definition);
	} finally {
		await lock.close();
		await fs.unlink(`${file}.lock`);
	}
}

export async function copyPresetDraft(home: string, cwd: string, source: string, id: string): Promise<PresetDraft> {
	const draft = newPresetDraft(id);
	const definition = structuredClone(await readPreset(home, source));
	for (const kind of ["instructions", "skills", "appendSystem"] as const)
		definition.resources[kind] = await Promise.all(
			definition.resources[kind].map(async entry =>
				entry.base === "preset"
					? { base: "absolute" as const, path: await presetResourcePath(entry, home, cwd, source) }
					: entry,
			),
		);
	draft.definition = { ...definition, id, name: id };
	return draft;
}

export async function copyPreset(home: string, cwd: string, source: string, id: string): Promise<void> {
	const draft = await copyPresetDraft(home, cwd, source, id);
	await savePresetDraft(home, cwd, draft);
}

export async function listPresets(home: string): Promise<PresetListItem[]> {
	const entries = await fs
		.readdir(path.join(home, "presets"), { withFileTypes: true })
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return [];
		});
	const items: PresetListItem[] = [
		{ id: "legacy", name: "原配置入口", status: "builtin" },
		{ id: "chat", name: "纯聊天", status: "builtin" },
		{ id: "bare", name: "空白工具", status: "builtin" },
	];
	for (const entry of entries
		.filter(item => item.isDirectory() && !["chat", "bare", "legacy"].includes(item.name))
		.sort((a, b) => a.name.localeCompare(b.name))) {
		try {
			items.push({ id: entry.name, name: (await readPreset(home, entry.name)).name, status: "configured" });
		} catch {
			items.push({ id: entry.name, status: "invalid" });
		}
	}
	return items;
}
