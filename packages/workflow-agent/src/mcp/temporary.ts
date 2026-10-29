import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { Config } from "../config/config";
import { digest, record } from "../storage";
import type { RunState } from "../runtime/state";
import type { TemporaryAccess } from "../runtime/temporary-access";
import { parseMcpConfig, type ProductMcpConfig } from "./config";
import type { ManagedMcp, TemporaryMcpHooks } from "./manager";

interface Candidate {
	name: string;
	raw: unknown;
	config: ProductMcpConfig;
	fingerprint: string;
	enabled: boolean;
	tools: MCPToolDefinition[];
	reason?: string;
}

export interface TemporaryMcpCandidate {
	name: string;
	type: "http" | "stdio";
	target: string;
	enabled: boolean;
	temporary: boolean;
	tools: { name: string; description?: string; inputSchema: MCPToolDefinition["inputSchema"]; temporary: boolean }[];
	connected: boolean;
	error?: string;
}

const connectionKey = (server: string) => JSON.stringify([server, "connect"]);
const toolKey = (server: string, tool: string) => JSON.stringify([server, "tool", tool]);

/** Candidate registration is cold. Resource approval never enables mcp_call or mcp_list themselves. */
export class TemporaryMcp {
	#state: RunState;
	#base: Config;
	#access: TemporaryAccess;
	#candidates = new Map<string, Candidate>();
	#owners = new Map<ManagedMcp, Set<string>>();
	#tails = new Map<string, Promise<void>>();
	#manager?: ManagedMcp;
	#closed = false;
	#lifetime = new AbortController();

	constructor(state: RunState, baseConfig: Config, access: TemporaryAccess) {
		this.#state = state;
		this.#base = baseConfig;
		this.#access = access;
		this.rebind();
	}

	rebind(): void {
		if (this.#closed || this.#state.light || this.#manager === this.#state.mcp) return;
		this.#manager = this.#state.mcp;
		this.#candidates.clear();
		for (const name of Object.keys(this.#base.mcpServers)) {
			const candidate = this.#candidate(name);
			if (!candidate) continue;
			this.#candidates.set(name, candidate);
		}
	}

	available(server: string): boolean {
		return !this.#closed && !this.#state.light && this.#candidate(server) !== undefined;
	}

	list(): TemporaryMcpCandidate[] {
		if (this.#closed || this.#state.light) return [];
		const statuses = this.#state.mcp.status();
		return [...this.#candidates.values()]
			.filter(candidate => this.available(candidate.name))
			.map(candidate => {
				const status = statuses.find(item => item.name === candidate.name);
				return {
					name: candidate.name,
					type: candidate.config.type ?? "stdio",
					target: candidate.config.type === "http" ? candidate.config.url : candidate.config.command,
					enabled: candidate.enabled,
					temporary: this.#keep(candidate, candidate.tools),
					tools: candidate.tools.map(tool => ({
						...(this.#state.mcp.sanitizeMetadata(tool) as MCPToolDefinition),
						temporary: this.#has(candidate, tool),
					})),
					connected: status?.status === "connected",
					error: status?.error,
				};
			});
	}

	discover(server: string, reason: string, signal?: AbortSignal): Promise<unknown> {
		return this.#serial(server, reason, signal, async (candidate, operationSignal) => {
			const result = await this.#state.mcp.list(server, operationSignal);
			const data = record(result, "MCP 工具目录");
			if (candidate.enabled && Array.isArray(data.tools))
				candidate.tools = structuredClone(data.tools) as MCPToolDefinition[];
			return result;
		});
	}

	call(
		server: string,
		tool: string,
		args: Record<string, unknown>,
		reason: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		// Freeze the submitted arguments before any queued approval can run.
		const snapshot = structuredClone(args);
		return this.#serial(server, reason, signal, (_candidate, operationSignal) =>
			this.#state.mcp.call(server, tool, snapshot, operationSignal),
		);
	}

	async grant(server: string, tool: string, signal?: AbortSignal): Promise<void> {
		await this.#serial(server, "人工选择在本次运行中使用此 MCP 工具", signal, async (candidate, operationSignal) => {
			const result = record(await this.#state.mcp.list(server, operationSignal), "MCP 工具目录");
			if (candidate.enabled) candidate.tools = structuredClone(result.tools) as MCPToolDefinition[];
			const definition = candidate.tools.find(item => item.name === tool);
			if (!definition) throw new Error("工具不在此 MCP 服务当前公布的列表中");
			operationSignal.throwIfAborted();
			this.#assertCurrent(candidate);
			if (!candidate.enabled)
				this.#access.grant("mcp", toolKey(server, tool), this.#toolFingerprint(candidate, definition));
		});
	}

	async revoke(server?: string, tool?: string): Promise<void> {
		if (server === undefined) this.#access.revoke("mcp");
		else if (tool !== undefined) this.#access.revoke("mcp", toolKey(server, tool));
		else {
			this.#access.revoke("mcp", connectionKey(server));
			for (const entry of this.#access.entries("mcp")) {
				const key: unknown = JSON.parse(entry.key);
				if (Array.isArray(key) && key[0] === server) this.#access.revoke("mcp", entry.key);
			}
		}
		await Promise.all(
			[...this.#owners].flatMap(([manager, names]) =>
				[...names].filter(name => server === undefined || name === server).map(name => manager.disconnect(name)),
			),
		);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#lifetime.abort(new Error("临时 MCP 已关闭"));
		this.#access.revoke("mcp");
		await Promise.all(
			[...this.#owners].flatMap(([manager, names]) => [...names].map(name => manager.unregisterTemporary(name))),
		);
		this.#owners.clear();
		this.#candidates.clear();
	}

	#candidate(name: string): Candidate | undefined {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || !Object.hasOwn(this.#base.mcpServers, name)) return;
		try {
			const raw = structuredClone(this.#base.mcpServers[name]);
			if (record(raw, "MCP 服务").enabled === false) return;
			const config = parseMcpConfig(raw);
			return {
				name,
				raw,
				config,
				fingerprint: digest(JSON.stringify(config)),
				enabled: Object.hasOwn(this.#state.config.mcpServers, name),
				tools: [],
			};
		} catch {
			return;
		}
	}

	#assertCurrent(candidate: Candidate): void {
		if (this.#closed || this.#state.light || this.#candidate(candidate.name)?.fingerprint !== candidate.fingerprint)
			throw new Error("MCP 配置已变更或服务已撤销，请重新申请");
	}

	#toolFingerprint(candidate: Candidate, tool: MCPToolDefinition): string {
		return digest(JSON.stringify([candidate.fingerprint, tool]));
	}
	#has(candidate: Candidate, tool: MCPToolDefinition): boolean {
		return (
			this.#candidate(candidate.name)?.fingerprint === candidate.fingerprint &&
			this.#access.has("mcp", toolKey(candidate.name, tool.name), this.#toolFingerprint(candidate, tool))
		);
	}
	#keep(candidate: Candidate, tools: readonly MCPToolDefinition[]): boolean {
		return !this.#closed && tools.some(tool => this.#has(candidate, tool));
	}

	#register(candidate: Candidate): void {
		if (candidate.enabled) return;
		const hooks: TemporaryMcpHooks = {
			assertCurrent: () => this.#assertCurrent(candidate),
			signal: () => AbortSignal.any([this.#lifetime.signal, this.#access.signal]),
			beforeConnect: async signal => {
				this.#assertCurrent(candidate);
				const decision = await this.#access.request(
					{
						kind: "mcp",
						key: connectionKey(candidate.name),
						fingerprint: candidate.fingerprint,
						label: candidate.name,
						reason: candidate.reason ?? "检查已登记 MCP 的工具目录",
						details: { server: candidate.name, scope: "connection", config: candidate.config },
					},
					signal,
				);
				if (decision === "deny") throw new Error("MCP 连接申请被拒绝；未获得临时使用权限");
				this.#assertCurrent(candidate);
			},
			beforeCall: async (tool, args, signal) => {
				this.#assertCurrent(candidate);
				const validated = structuredClone(
					validateToolArguments(
						{ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema },
						{ type: "toolCall", id: "temporary-mcp", name: tool.name, arguments: structuredClone(args) },
					),
				);
				candidate.tools = [...candidate.tools.filter(item => item.name !== tool.name), structuredClone(tool)];
				const decision = await this.#access.request(
					{
						kind: "mcp",
						key: toolKey(candidate.name, tool.name),
						fingerprint: this.#toolFingerprint(candidate, tool),
						label: `${candidate.name}/${tool.name}`,
						reason: candidate.reason ?? "调用已登记 MCP 工具",
						details: this.#state.mcp.sanitizeMetadata({
							server: candidate.name,
							tool: tool.name,
							scope: "tool",
							schema: tool.inputSchema,
							arguments: validated,
						}) as Record<string, unknown>,
					},
					signal,
				);
				if (decision === "deny") throw new Error("MCP 工具申请被拒绝；未获得临时使用权限");
				this.#assertCurrent(candidate);
				return validated;
			},
			keepConnected: tools => {
				if (tools.length) candidate.tools = structuredClone([...tools]);
				return this.#keep(candidate, tools);
			},
		};
		if (this.#state.mcp.registerTemporary(candidate.name, candidate.raw, hooks)) {
			let names = this.#owners.get(this.#state.mcp);
			if (!names) this.#owners.set(this.#state.mcp, (names = new Set()));
			names.add(candidate.name);
		}
	}

	#serial<T>(
		server: string,
		reason: string,
		signal: AbortSignal | undefined,
		action: (candidate: Candidate, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const combined = AbortSignal.any([this.#lifetime.signal, this.#access.signal, ...(signal ? [signal] : [])]);
		const operation = (this.#tails.get(server) ?? Promise.resolve()).then(async () => {
			combined.throwIfAborted();
			if (typeof reason !== "string") throw new Error("MCP 申请需要理由");
			if (!this.available(server)) throw new Error("MCP 服务不在有效的已登记候选中");
			this.rebind();
			let candidate = this.#candidates.get(server)!;
			const current = this.#candidate(server)!;
			if (current.fingerprint !== candidate.fingerprint) {
				await this.#state.mcp.unregisterTemporary(server);
				combined.throwIfAborted();
				candidate = current;
				this.#candidates.set(server, candidate);
				this.#register(candidate);
			}
			candidate.reason = reason;
			if (!candidate.enabled && !this.#owners.get(this.#state.mcp)?.has(server)) this.#register(candidate);
			try {
				return await action(candidate, combined);
			} finally {
				candidate.reason = undefined;
			}
		});
		const tail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#tails.set(server, tail);
		void tail.then(() => {
			if (this.#tails.get(server) === tail) this.#tails.delete(server);
		});
		return operation;
	}
}
