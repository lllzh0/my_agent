import * as path from "node:path";
const { join, isAbsolute } = path;
import * as fs from "node:fs/promises";
const { copyFile, mkdir } = fs;
import { randomUUID } from "node:crypto";
import { atomicJson, readJson, record } from "../storage.ts";

export interface Config {
	version: 1;
	model: { provider: string; id: string; apiKeyEnv: string; baseUrl?: string; authPath?: string };
	resources: {
		instructions: string[];
		skills: string[];
		extensions: { path: string; enabled: boolean; trustedDigest?: string }[];
		systemPrompt?: string;
		appendSystem: string[];
	};
	permissions: { readRoots: string[]; writeRoots: string[]; allowNetwork: boolean };
	search: { provider: "tavily"; apiKeyEnv: string; maxResults: number };
	sandbox: { required: boolean; allowedDomains: string[] };
	mcpServers: Record<string, unknown>;
}

export function defaultConfig(): Config {
	return {
		version: 1,
		model: { provider: "opencode-go", id: "deepseek-v4.1-flash", apiKeyEnv: "OPENCODE_API_KEY" },
		resources: { instructions: [], skills: [], extensions: [], appendSystem: [] },
		permissions: { readRoots: [], writeRoots: [], allowNetwork: true },
		search: { provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5 },
		sandbox: { required: true, allowedDomains: [] },
		mcpServers: {},
	};
}

export function validateConfig(input: unknown): Config {
	const raw = record(input, "配置");
	if (raw.version !== 1) throw new Error("配置 version 必须为 1，拒绝自动进行未知迁移");
	const model = record(raw.model, "model");
	if ("apiKey" in model) throw new Error("model.apiKey 不允许保存真实密钥；请使用 apiKeyEnv");
	for (const key of ["provider", "id", "apiKeyEnv"])
		if (typeof model[key] !== "string") throw new Error(`model.${key} 必须是文本`);
	if (!/^[A-Z_][A-Z0-9_]*$/.test(String(model.apiKeyEnv))) throw new Error("model.apiKeyEnv 必须是环境变量名");
	if (model.baseUrl !== undefined && (typeof model.baseUrl !== "string" || !/^https?:\/\//.test(model.baseUrl)))
		throw new Error("model.baseUrl 必须是 HTTP(S) 地址");
	if (model.authPath !== undefined && (typeof model.authPath !== "string" || !isAbsolute(model.authPath)))
		throw new Error("model.authPath 必须是已选择的绝对路径");
	const resources = record(raw.resources, "resources");
	for (const key of ["instructions", "skills", "appendSystem"])
		if (!Array.isArray(resources[key]) || !(resources[key] as unknown[]).every(x => typeof x === "string"))
			throw new Error(`resources.${key} 必须是路径列表`);
	if (resources.systemPrompt !== undefined && typeof resources.systemPrompt !== "string")
		throw new Error("resources.systemPrompt 必须是文件路径");
	if (!Array.isArray(resources.extensions)) throw new Error("resources.extensions 必须是列表");
	for (const ext of resources.extensions) {
		const item = record(ext, "extension");
		if (
			typeof item.path !== "string" ||
			typeof item.enabled !== "boolean" ||
			(item.trustedDigest !== undefined && !/^[a-f0-9]{64}$/.test(String(item.trustedDigest)))
		)
			throw new Error("扩展路径、启用状态或信任摘要无效");
	}
	const permissions = record(raw.permissions, "permissions");
	for (const key of ["readRoots", "writeRoots"])
		if (
			!Array.isArray(permissions[key]) ||
			!(permissions[key] as unknown[]).every(x => typeof x === "string" && isAbsolute(x))
		)
			throw new Error(`permissions.${key} 必须是绝对路径列表`);
	if (typeof permissions.allowNetwork !== "boolean") throw new Error("permissions.allowNetwork 必须是布尔值");
	const search = record(raw.search, "search");
	if (
		search.provider !== "tavily" ||
		!/^[A-Z_][A-Z0-9_]*$/.test(String(search.apiKeyEnv)) ||
		!Number.isInteger(search.maxResults) ||
		Number(search.maxResults) < 1 ||
		Number(search.maxResults) > 10
	)
		throw new Error("Tavily 配置无效，maxResults 取 1–10");
	const sandbox = record(raw.sandbox, "sandbox");
	if (sandbox.required !== true) throw new Error("第一阶段不允许静默关闭沙箱；sandbox.required 必须为 true");
	if (
		!Array.isArray(sandbox.allowedDomains) ||
		!sandbox.allowedDomains.every(x => typeof x === "string" && /^[a-z0-9*.-]+$/i.test(x))
	)
		throw new Error("sandbox.allowedDomains 无效");
	record(raw.mcpServers, "mcpServers");
	return raw as unknown as Config;
}

function rejectInlineMcpCredentials(servers: Record<string, unknown>): void {
	for (const [name, value] of Object.entries(servers)) {
		const server = record(value, `MCP ${name}`);
		for (const key of ["headers", "env"]) {
			if (!server[key]) continue;
			for (const item of Object.values(record(server[key], `MCP ${key}`)))
				if (typeof item !== "string" || !/\$\{[A-Z_][A-Z0-9_]*\}/.test(item) || item.startsWith("!"))
					throw new Error(`MCP ${key} 必须使用环境变量引用，不能保存凭据或执行命令`);
		}
	}
}

export async function loadConfig(home: string): Promise<Config> {
	const path = join(home, "config.json");
	try {
		const value = await readJson(path);
		return value === undefined ? defaultConfig() : validateConfig(value);
	} catch (error) {
		throw new Error(
			`${path}：${error instanceof Error ? error.message : String(error)}；可从 config.previous.json 恢复`,
		);
	}
}

export async function saveConfig(home: string, input: unknown): Promise<void> {
	const config = validateConfig(input);
	rejectInlineMcpCredentials(config.mcpServers);
	await mkdir(home, { recursive: true, mode: 0o700 });
	try {
		const previous = await readJson(join(home, "config.json"));
		if (previous !== undefined) {
			validateConfig(previous);
			await copyFile(join(home, "config.json"), join(home, "config.previous.json"));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await atomicJson(join(home, "config.json"), config);
}

export async function recoverConfig(home: string): Promise<void> {
	const previous = validateConfig(await readJson(join(home, "config.previous.json")));
	try {
		await copyFile(join(home, "config.json"), join(home, `config.corrupt-${randomUUID()}.json`));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await atomicJson(join(home, "config.json"), previous);
}
