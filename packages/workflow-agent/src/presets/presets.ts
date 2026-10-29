import * as fs from "node:fs/promises";
import * as path from "node:path";
import { contained } from "../policy/paths";
import { normalizeProfileName } from "@oh-my-pi/pi-utils/profile-name";
import type { Config } from "../config/config";
import { digest, readJson, record } from "../storage";
import { PRODUCT_TOOL_NAMES, BARE_TOOL_NAMES } from "../runtime/tool-catalog";
import { parseMcpConfig } from "../mcp/config";

export interface PresetPath {
	base: "workspace" | "preset" | "absolute";
	path: string;
}
export interface PresetDefinition {
	version: 1;
	id: string;
	name: string;
	mode: "agent" | "chat";
	model?: { default: string; allowed: string[] };
	resources: { instructions: PresetPath[]; skills: PresetPath[]; appendSystem: PresetPath[] };
	tools: string[];
	mcpServers: string[];
	permissions?: Config["permissions"];
}
export interface PresetIdentity {
	version: 1;
	id: string;
	signature: string;
}
export interface ResolvedPreset {
	definition: PresetDefinition;
	identity: PresetIdentity;
	config: Config;
	light: boolean;
	agentDir: string;
	sessionDir: string;
}

export function presetId(input: string): string {
	const id = normalizeProfileName(input);
	if (!id || id !== input) throw new Error("预设 ID 必须是明确的名称，不能是 default 或包含首尾空格。");
	return id;
}

function strings(input: unknown, label: string): string[] {
	if (
		!Array.isArray(input) ||
		input.some(value => typeof value !== "string" || !value.trim()) ||
		new Set(input).size !== input.length
	)
		throw new Error(`${label} 必须是不重复的非空字符串列表`);
	return input as string[];
}

function keys(input: Record<string, unknown>, allowed: string[], label: string): void {
	if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error(`${label} 含有不支持的字段`);
}

export function validatePreset(input: unknown): PresetDefinition {
	const value = record(input, "预设");
	keys(value, ["version", "id", "name", "mode", "model", "resources", "tools", "mcpServers", "permissions"], "预设");
	if (value.version !== 1 || typeof value.id !== "string") throw new Error("预设 version 或 ID 无效");
	presetId(value.id);
	if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80)
		throw new Error("预设显示名称须为 1–80 字");
	if (value.mode !== "chat" && value.mode !== "agent") throw new Error("预设 mode 须为 agent 或 chat");
	const resources = record(value.resources, "resources");
	keys(resources, ["instructions", "skills", "appendSystem"], "resources");
	for (const kind of ["instructions", "skills", "appendSystem"]) {
		if (!Array.isArray(resources[kind])) throw new Error(`resources.${kind} 必须是路径列表`);
		for (const item of resources[kind]) {
			const entry = record(item, kind);
			keys(entry, ["base", "path"], kind);
			if (
				!["workspace", "preset", "absolute"].includes(String(entry.base)) ||
				typeof entry.path !== "string" ||
				!entry.path.trim() ||
				entry.path.includes("\0")
			)
				throw new Error(`resources.${kind} 路径无效`);
		}
	}
	const tools = strings(value.tools, "tools");
	if (tools.some(name => !(PRODUCT_TOOL_NAMES as readonly string[]).includes(name)))
		throw new Error("预设包含未知或未开放的产品工具");
	const mcp = strings(value.mcpServers, "mcpServers");
	if ((resources.skills as unknown[]).length && !tools.includes("read")) throw new Error("技能需要 read 工具");
	if (tools.includes("bash") && (!tools.includes("job_output") || !tools.includes("job_stop")))
		throw new Error("bash 需要 job_output 和 job_stop");
	if (mcp.length && (!tools.includes("mcp_list") || !tools.includes("mcp_call")))
		throw new Error("MCP 服务需要 mcp_list 和 mcp_call");
	if (!mcp.length && tools.some(name => ["mcp_list", "mcp_call", "import_mcp_source"].includes(name)))
		throw new Error("MCP 工具需要显式选择服务");
	if (
		value.mode === "chat" &&
		(tools.length || mcp.length || Object.values(resources).some(items => (items as unknown[]).length))
	)
		throw new Error("chat 预设必须没有工具、技能、指令或 MCP");
	if (value.model !== undefined) {
		const model = record(value.model, "model");
		keys(model, ["default", "allowed"], "model");
		if (typeof model.default !== "string" || !strings(model.allowed, "model.allowed").includes(model.default))
			throw new Error("默认模型必须在 allowed 中");
	}
	if (value.permissions !== undefined) {
		const permissions = record(value.permissions, "permissions");
		keys(permissions, ["readRoots", "writeRoots", "allowNetwork", "approval"], "permissions");
		for (const kind of ["readRoots", "writeRoots"])
			if (strings(permissions[kind], kind).some(root => !path.isAbsolute(root)))
				throw new Error("权限目录必须是绝对路径");
		if (
			typeof permissions.allowNetwork !== "boolean" ||
			![undefined, "manual", "auto"].includes(permissions.approval as "manual" | "auto" | undefined)
		)
			throw new Error("预设权限只支持 manual/auto，不能保存 full");
	}
	return value as unknown as PresetDefinition;
}

export function builtinPreset(id: string): PresetDefinition {
	if (!["chat", "bare"].includes(id)) throw new Error(`未知内置预设：${id}`);
	return {
		version: 1,
		id,
		name: id === "chat" ? "纯聊天" : "空白工具",
		mode: id === "chat" ? "chat" : "agent",
		resources: { instructions: [], skills: [], appendSystem: [] },
		tools: id === "chat" ? [] : [...BARE_TOOL_NAMES],
		mcpServers: [],
	};
}

export async function readPreset(home: string, id: string): Promise<PresetDefinition> {
	presetId(id);
	if (id === "legacy") throw new Error("legacy 沿用 config.json，没有单独清单");
	if (["chat", "bare"].includes(id)) return builtinPreset(id);
	const file = path.join(home, "presets", id, "preset.json");
	const input = await readJson(file);
	if (input === undefined) throw new Error(`预设不存在：${id}；请先用 preset create 创建。`);
	const value = validatePreset(input);
	if (value.id !== id) throw new Error("预设 ID 与目录名不一致");
	return value;
}

export async function presetResourcePath(entry: PresetPath, home: string, cwd: string, id: string): Promise<string> {
	if (entry.base === "absolute") {
		if (!path.isAbsolute(entry.path)) throw new Error("absolute 资源必须使用绝对路径");
		return fs.realpath(entry.path);
	}
	if (path.isAbsolute(entry.path)) throw new Error("相对资源不能使用绝对路径");
	const root = await fs.realpath(entry.base === "workspace" ? cwd : path.join(home, "presets", id));
	const target = await fs.realpath(path.resolve(root, entry.path));
	if (!contained(root, target)) throw new Error("预设资源超出声明的根目录");
	return target;
}

/** Compile references only; this never contacts a model or starts an MCP server. */
export async function resolvePreset(home: string, cwd: string, id: string, base: Config): Promise<ResolvedPreset> {
	return compilePreset(home, cwd, await readPreset(home, id), base);
}

/** Check an unsaved definition through the same compiler used at startup. */
export async function compilePreset(
	home: string,
	cwd: string,
	input: PresetDefinition,
	base: Config,
): Promise<ResolvedPreset> {
	const definition = validatePreset(input);
	const id = definition.id;
	const config = structuredClone(base);
	const candidates = [base.model, ...(base.models ?? [])];
	const selected = definition.model ?? {
		default: base.model.key ?? `${base.model.provider}/${base.model.id}`,
		allowed: [base.model.key ?? `${base.model.provider}/${base.model.id}`],
	};
	const models = selected.allowed.map(key => {
		const model = candidates.find(item => (item.key ?? `${item.provider}/${item.id}`) === key);
		if (!model) throw new Error(`预设引用的模型连接不存在：${key}`);
		return structuredClone(model);
	});
	config.model = models.find(item => (item.key ?? `${item.provider}/${item.id}`) === selected.default)!;
	config.models = models.filter(item => item !== config.model);
	config.resources = {
		instructions: [],
		skills: [],
		extensions: [],
		appendSystem: [],
		disabled: PRODUCT_TOOL_NAMES.filter(name => !definition.tools.includes(name)).map(name => `tool:${name}`),
	};
	for (const kind of ["instructions", "skills", "appendSystem"] as const)
		config.resources[kind] = await Promise.all(
			definition.resources[kind].map(entry => presetResourcePath(entry, home, cwd, id)),
		);
	for (const file of [...config.resources.instructions, ...config.resources.appendSystem])
		if (!(await fs.stat(file)).isFile()) throw new Error(`预设指令必须是文件：${file}`);
	for (const file of config.resources.skills)
		if (path.basename(file) !== "SKILL.md" || !(await fs.stat(file)).isFile())
			throw new Error("预设技能必须逐个引用 SKILL.md，不能引用会自动扩大的目录");
	config.mcpServers = Object.fromEntries(
		definition.mcpServers.map(name => {
			if (!Object.hasOwn(base.mcpServers, name)) throw new Error(`预设引用的 MCP 不存在：${name}`);
			const server = base.mcpServers[name];
			parseMcpConfig(server);
			if (record(server, name).enabled === false) throw new Error(`预设引用的 MCP 已关闭：${name}`);
			return [name, structuredClone(server)];
		}),
	);
	if (definition.permissions) config.permissions = structuredClone(definition.permissions);
	return {
		definition,
		config,
		light: definition.mode === "chat",
		identity: { version: 1, id, signature: digest(JSON.stringify({ ...definition, name: undefined })) },
		agentDir: path.join(home, "omp", "presets", id, "agent"),
		sessionDir: path.join(home, "presets", id, "sessions"),
	};
}

export function samePreset(stored: unknown, current?: PresetIdentity): boolean {
	if (!current) return stored === undefined;
	if (!stored || typeof stored !== "object") return false;
	const value = stored as Record<string, unknown>;
	return value.version === 1 && value.id === current.id && value.signature === current.signature;
}
