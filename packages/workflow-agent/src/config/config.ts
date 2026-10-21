import * as path from "node:path";
const { join, isAbsolute } = path;
import * as fs from "node:fs/promises";
const { copyFile, mkdir } = fs;
import { randomUUID } from "node:crypto";
import type { Api, ThinkingConfig } from "@oh-my-pi/pi-ai";
import { getModelsConfigSchemaBundle } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { atomicJson, readJson, record } from "../storage.ts";

/** API-key chat transports admitted by this product (no ambient/native-login transports). */
export const MODEL_APIS: readonly Api[] = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

export interface ModelConfig {
	key?: string;
	name?: string;
	provider: string;
	id: string;
	apiKeyEnv: string;
	baseUrl?: string;
	authPath?: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	thinking?: ThinkingConfig;
}

export interface Config {
	version: 1;
	model: ModelConfig;
	models?: ModelConfig[];
	resources: {
		instructions: string[];
		skills: string[];
		extensions: { path: string; enabled: boolean; trustedDigest?: string }[];
		systemPrompt?: string;
		appendSystem: string[];
		/** Resource ids disabled by the human; paths remain available for re-enabling. */
		disabled?: string[];
	};
	permissions: { readRoots: string[]; writeRoots: string[]; allowNetwork: boolean; approval?: "manual" | "auto" };
	execution?: { envNames: string[] };
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

export function validateModelConfig(input: unknown, label: string): ModelConfig {
	const model = record(input, label);
	const allowed = [
		"key",
		"name",
		"provider",
		"id",
		"apiKeyEnv",
		"baseUrl",
		"authPath",
		"api",
		"contextWindow",
		"maxTokens",
		"reasoning",
		"input",
		"thinking",
	];
	if ("apiKey" in model) throw new Error(`${label}.apiKey 不允许保存真实密钥；请使用 apiKeyEnv`);
	if (Object.keys(model).some(key => !allowed.includes(key))) throw new Error(`${label} 有不支持的模型字段`);
	for (const key of [
		"provider",
		"id",
		"apiKeyEnv",
		...(model.key !== undefined ? ["key"] : []),
		...(model.name !== undefined ? ["name"] : []),
	])
		if (typeof model[key] !== "string" || !model[key].trim()) throw new Error(`${label}.${key} 必须是非空文本`);
	if (!/^[A-Z_][A-Z0-9_]*$/.test(String(model.apiKeyEnv))) throw new Error(`${label}.apiKeyEnv 必须是环境变量名`);
	for (const key of ["provider", "id", "key"])
		if (typeof model[key] === "string" && /[\s\x00-\x1f\x7f]/.test(model[key]))
			throw new Error(`${label}.${key} 不能包含空白或控制字符`);
	if (model.baseUrl !== undefined) {
		if (typeof model.baseUrl !== "string" || !/^https?:\/\//.test(model.baseUrl))
			throw new Error(`${label}.baseUrl 必须是 HTTP(S) 地址`);
		const url = new URL(model.baseUrl);
		if (url.username || url.password || url.search || url.hash)
			throw new Error(`${label}.baseUrl 不能携带凭据、查询参数或片段`);
	}
	if (model.authPath !== undefined && (typeof model.authPath !== "string" || !isAbsolute(model.authPath)))
		throw new Error(`${label}.authPath 必须是已选择的绝对路径`);
	for (const key of ["contextWindow", "maxTokens"])
		if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || Number(model[key]) < 1))
			throw new Error(`${label}.${key} 必须是正整数`);
	if (
		typeof model.contextWindow === "number" &&
		typeof model.maxTokens === "number" &&
		model.maxTokens > model.contextWindow
	)
		throw new Error(`${label}.maxTokens 不能超过 contextWindow`);
	if (model.api !== undefined && (typeof model.api !== "string" || !MODEL_APIS.includes(model.api)))
		throw new Error(`${label}.api 必须是本入口支持的 API-key 对话接口：${MODEL_APIS.join("、")}`);
	// Reuse the native metadata grammar; no provider-name heuristics here.
	getModelsConfigSchemaBundle().ModelOverrideSchema.assert(
		Object.fromEntries(
			["reasoning", "input", "thinking"].filter(key => model[key] !== undefined).map(key => [key, model[key]]),
		),
	);
	if (Array.isArray(model.input) && model.input.length === 0) throw new Error(`${label}.input 必须是非空输入能力列表`);
	if (model.thinking !== undefined) {
		const thinking = record(model.thinking, `${label}.thinking`);
		const fields = ["mode", "efforts", "defaultLevel", "effortMap", "supportsDisplay", "requiresEffort"];
		if (Object.keys(thinking).some(key => !fields.includes(key))) throw new Error(`${label}.thinking 有不支持的字段`);
		if (
			!Array.isArray(thinking.efforts) ||
			!thinking.efforts.length ||
			new Set(thinking.efforts).size !== thinking.efforts.length
		)
			throw new Error(`${label}.thinking.efforts 必须是非空且不重复的强度列表`);
		const order = THINKING_EFFORTS as readonly string[];
		if (
			thinking.efforts.some(
				(value, index, values) => index > 0 && order.indexOf(values[index - 1]) >= order.indexOf(value),
			)
		)
			throw new Error(`${label}.thinking.efforts 必须从低到高排序`);
		if (thinking.defaultLevel !== undefined && !thinking.efforts.includes(thinking.defaultLevel))
			throw new Error(`${label}.thinking.defaultLevel 必须在 efforts 中`);
		if (model.reasoning === false) throw new Error(`${label}.thinking 与 reasoning=false 冲突`);
	}
	return model as unknown as ModelConfig;
}

export function validateConfig(input: unknown): Config {
	const raw = record(input, "配置");
	if (raw.version !== 1) throw new Error("配置 version 必须为 1，拒绝自动进行未知迁移");
	const models = [validateModelConfig(raw.model, "model")];
	if (raw.models !== undefined) {
		if (!Array.isArray(raw.models)) throw new Error("models 必须是模型连接列表");
		models.push(...raw.models.map((model, index) => validateModelConfig(model, `models[${index}]`)));
	}
	const keys = models.map(model => model.key ?? `${model.provider}/${model.id}`);
	if (new Set(keys).size !== keys.length)
		throw new Error("模型连接 key 重复；相同供应商/型号的不同连接须分别指定 key");
	const resources = record(raw.resources, "resources");
	if (
		resources.disabled !== undefined &&
		(!Array.isArray(resources.disabled) ||
			!resources.disabled.every(id => typeof id === "string" && /^(tool|skill|instruction|system):.+$/s.test(id)))
	)
		throw new Error("resources.disabled 必须是 tool、skill、instruction 或 system 的资源 ID 列表");
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
	if (permissions.approval !== undefined && permissions.approval !== "manual" && permissions.approval !== "auto")
		throw new Error("permissions.approval 只能是 manual 或 auto；完整授权 full 必须由用户在当前会话显式选择");
	if (raw.execution !== undefined) {
		const execution = record(raw.execution, "execution");
		if (
			!Array.isArray(execution.envNames) ||
			!execution.envNames.every(name => typeof name === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name))
		)
			throw new Error("execution.envNames 必须是环境变量名称列表，不能保存变量值");
	}
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
