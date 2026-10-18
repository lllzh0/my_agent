import type { MCPHttpServerConfig, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { McpResearchIntent } from "../research/types";
import { record } from "../storage";

export type ProductMcpConfig = (MCPHttpServerConfig | MCPStdioServerConfig) & {
	researchTools?: Record<string, McpResearchIntent>;
};

const reference = /^(?:[A-Za-z][A-Za-z0-9_-]* )?\$\{([A-Z_][A-Z0-9_]*)\}$/;
const reservedEnvironment =
	/^(?:PATH|HOME|TMPDIR|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|IFS|LD_.*|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS|BUN_INSPECT.*)$/;

function references(input: unknown, kind: "env" | "headers"): Record<string, string> | undefined {
	if (input === undefined) return;
	const values = record(input, kind);
	for (const [key, value] of Object.entries(values)) {
		if (typeof value !== "string" || !reference.test(value))
			throw new Error(`${kind}.${key} 必须是环境变量引用，可带 Bearer 等认证前缀，不能保存密钥或执行命令`);
		if (kind === "env" && (!/^[A-Z_][A-Z0-9_]*$/.test(key) || reservedEnvironment.test(key)))
			throw new Error(`env.${key} 属于无效名称或受保护的启动环境变量`);
		if (kind === "headers" && !/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`headers.${key} 名称无效`);
	}
	return values as Record<string, string>;
}

/** Product configuration is deliberately narrower than OMP's auto-discovery configuration. */
export function parseMcpConfig(input: unknown): ProductMcpConfig {
	const raw = record(input, "MCP 服务");
	const type = raw.type ?? (raw.url !== undefined ? "http" : "stdio");
	if (type !== "http" && type !== "stdio") throw new Error("当前支持 http 与 stdio；OAuth 和旧 SSE 尚未接入");
	const allowed = new Set([
		"type",
		"enabled",
		"timeout",
		"researchTools",
		"requestIdFormat",
		...(type === "http" ? ["url", "headers"] : ["command", "args", "env"]),
	]);
	for (const key of Object.keys(raw))
		if (!allowed.has(key)) throw new Error(`MCP 字段 ${key} 尚未接入；本地工作目录固定为当前工作区`);
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("MCP enabled 必须是布尔值");
	const timeout = raw.timeout ?? 30_000;
	if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 120_000)
		throw new Error("MCP timeout 必须是 100–120000 毫秒，不能关闭超时");
	if (raw.requestIdFormat !== undefined && raw.requestIdFormat !== "string" && raw.requestIdFormat !== "number")
		throw new Error("MCP requestIdFormat 必须是 string 或 number");
	let researchTools: Record<string, McpResearchIntent> | undefined;
	if (raw.researchTools !== undefined) {
		const configured = record(raw.researchTools, "MCP researchTools");
		if (Object.keys(configured).length > 1000) throw new Error("MCP researchTools 超过 1000 项上限");
		for (const [tool, intent] of Object.entries(configured))
			if (!tool.trim() || tool.length > 256 || (intent !== "content" && intent !== "discovery"))
				throw new Error("MCP researchTools 必须把工具名明确设为 content（正文）或 discovery（搜索摘要）");
		researchTools = configured as Record<string, McpResearchIntent>;
	}
	const common = {
		researchTools,
		timeout: Number(timeout),
		requestIdFormat: raw.requestIdFormat as "string" | "number" | undefined,
	};
	if (type === "http") {
		if (typeof raw.url !== "string") throw new Error("MCP url 必须是 HTTP(S) 地址");
		const url = new URL(raw.url);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
			throw new Error("MCP url 只能包含 HTTP(S) 服务地址，凭据请放在 headers 环境变量引用中，不使用查询参数");
		if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			throw new Error("远程 MCP 必须使用 HTTPS；HTTP 仅用于本机服务");
		return {
			...common,
			type,
			url: url.href,
			headers: references(raw.headers, "headers"),
			headerPolicy: "origin-locked",
			redirectPolicy: "same-origin",
			shutdownTimeout: Math.min(common.timeout, 1000),
		};
	}
	if (typeof raw.command !== "string" || !raw.command.trim() || /[\0\r\n]/.test(raw.command))
		throw new Error("MCP command 必须是已安装程序的名称或路径");
	if (
		raw.args !== undefined &&
		(!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === "string" && !arg.includes("\0")))
	)
		throw new Error("MCP args 必须是文本参数列表");
	return {
		...common,
		type: "stdio",
		command: raw.command,
		args: raw.args as string[] | undefined,
		env: references(raw.env, "env"),
		envPolicy: "literal",
	};
}

export function expandMcpValues(
	values: Record<string, string> | undefined,
	secrets: Set<string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values ?? {}).map(([key, template]) => {
			const name = reference.exec(template)![1];
			const value = process.env[name];
			if (!value) throw new Error(`MCP 缺少环境变量 ${name}；请在启动产品的终端设置后重启`);
			if (/[\0\r\n]/.test(value)) throw new Error(`MCP 环境变量 ${name} 不能包含换行或空字节`);
			secrets.add(value);
			return [key, template.replace(/\$\{[A-Z_][A-Z0-9_]*\}/, () => value)];
		}),
	);
}
