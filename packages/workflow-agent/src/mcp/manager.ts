import * as path from "node:path";
import { quote } from "shell-quote";
import { callTool, connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Policy } from "../policy/policy";
import type { Sandbox } from "../processes/sandbox";
import { executionEnvironment } from "../processes/environment";
import { redact, record } from "../storage";
import { expandMcpValues, parseMcpConfig, type ProductMcpConfig } from "./config";

interface Entry {
	name: string;
	config?: ProductMcpConfig;
	status: "configured" | "disabled" | "invalid" | "connecting" | "connected" | "calling" | "disconnected" | "error";
	error?: string;
	connection?: MCPServerConnection;
	tools?: MCPToolDefinition[];
	operation?: Promise<unknown>;
	controller?: AbortController;
	closing?: Promise<void>;
	stderr?: string;
}

export class ManagedMcp {
	#entries = new Map<string, Entry>();
	#secrets = new Set<string>();
	#closed = false;
	constructor(
		configs: Record<string, unknown>,
		readonly policy: Policy,
		readonly sandbox: Sandbox,
		readonly cwd: string,
		readonly stateDir: string,
		readonly light: boolean,
	) {
		for (const [name, raw] of Object.entries(structuredClone(configs))) {
			const entry: Entry = { name, status: "configured" };
			this.#entries.set(name, entry);
			try {
				if (light || record(raw, "MCP 服务").enabled === false) {
					entry.status = "disabled";
					continue;
				}
				if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name))
					throw new Error("MCP 名称仅支持 1–64 位字母、数字、点、下划线和短横线");
				entry.config = parseMcpConfig(raw);
			} catch (error) {
				entry.status = "invalid";
				entry.error = this.#message(error);
			}
		}
	}
	#message(error: unknown): string {
		return this.#sanitize(error instanceof Error ? error.message : String(error));
	}
	#sanitize(text: string): string {
		for (const secret of this.#secrets) text = text.split(secret).join("[REDACTED]");
		return String(redact(text));
	}
	#output(value: unknown): unknown {
		const scrub = (value: unknown): unknown => {
			if (typeof value === "string") return this.#sanitize(value);
			if (Array.isArray(value)) return value.map(scrub);
			if (value && typeof value === "object")
				return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.#sanitize(key), scrub(item)]));
			return value;
		};
		const sanitized = scrub(value);
		const serialized = JSON.stringify(sanitized);
		return serialized.length > 200_000 ? { truncated: true, preview: serialized.slice(0, 200_000) } : sanitized;
	}
	status() {
		return [...this.#entries.values()].map(entry => ({
			name: entry.name,
			type: entry.config?.type,
			target: entry.config?.type === "http" ? entry.config.url : entry.config?.command,
			status: entry.status === "connected" && !entry.connection?.transport.connected ? "disconnected" : entry.status,
			toolCount: entry.tools?.length ?? 0,
			error: entry.error,
		}));
	}
	#entry(name: string): Entry {
		if (this.#closed) throw new Error("MCP 管理器已关闭");
		const entry = this.#entries.get(name);
		if (!entry) throw new Error("MCP 服务不在当前配置中；模型不能自行增加连接");
		if (entry.status === "disabled" || !entry.config) throw new Error(entry.error ?? "MCP 服务未启用");
		if (entry.operation || entry.closing) throw new Error("此 MCP 服务正在处理另一个请求，请等待或先断开");
		return entry;
	}
	async #run<T>(
		entry: Entry,
		signal: AbortSignal | undefined,
		action: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		entry.controller = controller;
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const operation = (async () => {
			try {
				combined.throwIfAborted();
				return await action(combined);
			} catch (error) {
				await this.#drop(entry);
				entry.status = "error";
				entry.error = this.#message(error) + (entry.stderr ? `\n服务诊断：${entry.stderr}` : "");
				throw new Error(entry.error);
			}
		})();
		entry.operation = operation;
		try {
			return await operation;
		} finally {
			entry.operation = undefined;
			entry.controller = undefined;
		}
	}
	async #connect(entry: Entry, signal: AbortSignal): Promise<MCPServerConnection> {
		const config = entry.config!;
		this.#checkPolicy(config);
		if (entry.connection?.transport.connected) return entry.connection;
		await this.#drop(entry);
		signal.throwIfAborted();
		entry.status = "connecting";
		entry.stderr = "";
		await untilAborted(signal, () =>
			this.policy.authorize({
				tool: `mcp-connect:${entry.name}`,
				kind: "external",
				target: config.type === "http" ? config.url : config.command,
				parameters:
					config.type === "http"
						? { headers: config.headers }
						: { args: config.args ?? [], env: config.env, cwd: this.cwd, sandbox: true },
			}),
		);
		signal.throwIfAborted();
		this.#checkPolicy(config);
		let prepared: ProductMcpConfig;
		if (config.type === "http") prepared = { ...config, headers: expandMcpValues(config.headers, this.#secrets) };
		else {
			const env = {
				...executionEnvironment(this.stateDir),
				HOME: path.join(this.stateDir, "scratch"),
				...expandMcpValues(config.env, this.#secrets),
			};
			const wrapped = await this.sandbox.wrap(quote([config.command, ...(config.args ?? [])]), signal);
			signal.throwIfAborted();
			prepared = {
				...config,
				command: "/bin/bash",
				args: ["--noprofile", "--norc", "-c", wrapped],
				cwd: this.cwd,
				env,
			};
		}
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeout!)]);
		this.#checkPolicy(config);
		const connection = await connectToServer(entry.name, prepared, {
			signal: deadline,
			stdio: {
				inheritEnv: false,
				detached: true,
				onStderr: text => {
					entry.stderr = this.#sanitize((entry.stderr ?? "") + text).slice(-2000);
				},
			},
			async onRequest(method) {
				if (method === "ping") return {};
				if (method === "roots/list") return { roots: [] };
				throw new Error("MCP 服务端请求未开放");
			},
		});
		entry.connection = connection;
		deadline.throwIfAborted();
		entry.tools = await listTools(connection, { signal: deadline });
		entry.status = "connected";
		entry.error = undefined;
		return connection;
	}
	#checkPolicy(config: ProductMcpConfig): void {
		if (this.policy.mode === "plan") throw new Error("计划模式禁止 MCP 连接和调用");
		if (config.type === "http" && !this.policy.settings.allowNetwork) throw new Error("联网已禁用，MCP 未连接");
	}
	async list(name?: string, signal?: AbortSignal): Promise<unknown> {
		if (!name) return this.status();
		const entry = this.#entry(name);
		return this.#run(entry, signal, async signal => {
			await this.#connect(entry, signal);
			return this.#output({ server: name, tools: entry.tools });
		});
	}
	async call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const entry = this.#entry(name);
		if (entry.status === "error" || (entry.connection && !entry.connection.transport.connected))
			throw new Error("上次 MCP 连接或调用失败；请先用 mcp_list 或菜单重新连接，核实结果后再决定是否重试");
		if (JSON.stringify(args).length > 100_000) throw new Error("MCP 参数过大，请缩小到 100KB 以内");
		return this.#run(entry, signal, async signal => {
			const connection = await this.#connect(entry, signal);
			if (!entry.tools?.some(item => item.name === tool)) throw new Error("工具不在此 MCP 服务当前公布的列表中");
			await untilAborted(signal, () =>
				this.policy.authorize({
					tool: `mcp-call:${name}/${tool}`,
					kind: "external",
					target: entry.config!.type === "http" ? entry.config!.url : entry.config!.command,
					parameters: { tool, arguments: args },
				}),
			);
			signal.throwIfAborted();
			this.#checkPolicy(entry.config!);
			entry.status = "calling";
			try {
				const output = await callTool(connection, tool, args, {
					signal: AbortSignal.any([signal, AbortSignal.timeout(entry.config!.timeout!)]),
				});
				entry.status = "connected";
				return this.#output(output);
			} catch (error) {
				throw new Error(`MCP 调用未正常返回，外部执行结果可能未知，未自动重试：${this.#message(error)}`);
			}
		});
	}
	async #drop(entry: Entry): Promise<void> {
		const connection = entry.connection;
		entry.connection = undefined;
		entry.tools = undefined;
		if (connection) await disconnectServer(connection);
	}
	disconnect(name: string): Promise<void> {
		const entry = this.#entries.get(name);
		if (!entry) return Promise.resolve();
		entry.closing ??= (async () => {
			entry.controller?.abort(new Error("MCP 连接已断开"));
			await entry.operation?.catch(() => undefined);
			await this.#drop(entry);
			if (entry.config) entry.status = "disconnected";
			entry.error = undefined;
		})();
		return entry.closing.finally(() => {
			entry.closing = undefined;
		});
	}
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all([...this.#entries.keys()].map(name => this.disconnect(name)));
	}
}
