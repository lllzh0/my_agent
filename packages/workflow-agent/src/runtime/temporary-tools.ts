import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { digest } from "../storage";
import { resourceDisabled } from "./resources";
import type { RunState } from "./state";
import { TemporaryAccess, type AccessDecision } from "./temporary-access";
import { PRODUCT_TOOL_NAMES } from "./tool-catalog";

export type ToolAccessDecision = AccessDecision;

export interface ToolAccessRequest {
	tool: string;
	reason: string;
	arguments: Record<string, unknown>;
}

export type ToolAccessApprover = (request: ToolAccessRequest) => Promise<ToolAccessDecision>;

const mcpTools = new Set(["mcp_list", "mcp_call", "import_mcp_source"]);
const jobTools = new Set(["job_output", "job_stop"]);

/** Capability grants live only in this Host; each operation still uses its original policy checks. */
export class TemporaryTools {
	#state: RunState;
	#tools = new Map<string, ToolDefinition>();
	#access: TemporaryAccess;
	#ownsAccess: boolean;
	#jobs = new Set<string>();
	#jobRevision = 0;
	#revision = 0;
	#closed = false;
	#invalidated = new AbortController();

	constructor(state: RunState, tools: readonly ToolDefinition[], shared?: TemporaryAccess) {
		this.#state = state;
		this.#access = shared ?? new TemporaryAccess(state.policy);
		this.#ownsAccess = shared === undefined;
		const productNames = new Set<string>(PRODUCT_TOOL_NAMES);
		for (const tool of tools)
			if (productNames.has(tool.name) && tool.name !== "goal" && tool.name !== "request_tool")
				this.#tools.set(tool.name, tool);
	}

	setApprover(approver: ToolAccessApprover): void {
		this.#access.setApprover(request => {
			const args = request.details.arguments;
			if (args === null || typeof args !== "object" || Array.isArray(args)) return Promise.resolve("deny");
			return approver({ tool: request.key, reason: request.reason, arguments: args as Record<string, unknown> });
		}, "tool");
	}

	list(): {
		name: string;
		label: string;
		enabled: boolean;
		temporary: boolean;
		scoped: boolean;
		description: string;
		parameters: ToolDefinition["parameters"];
	}[] {
		return [...this.#tools.values()]
			.filter(tool => this.#available(tool.name))
			.map(tool => ({
				name: tool.name,
				label: tool.label,
				enabled: !resourceDisabled(this.#state.config, `tool:${tool.name}`),
				temporary: this.#hasGrant(tool.name),
				scoped:
					jobTools.has(tool.name) &&
					this.#jobs.size > 0 &&
					resourceDisabled(this.#state.config, `tool:${tool.name}`) &&
					!this.#hasGrant(tool.name),
				description: tool.description,
				parameters: tool.parameters,
			}));
	}

	allows(name: string, input?: unknown): boolean {
		if (!this.#available(name)) return false;
		if (!resourceDisabled(this.#state.config, `tool:${name}`) || this.#hasGrant(name)) return true;
		return (
			jobTools.has(name) &&
			input !== null &&
			typeof input === "object" &&
			"id" in input &&
			typeof input.id === "string" &&
			this.#jobs.has(input.id)
		);
	}

	isEnabled(name: string): boolean {
		return this.allows(name) || (this.#available(name) && jobTools.has(name) && this.#jobs.size > 0);
	}

	grant(name: string): void {
		const tool = this.#tool(name);
		this.#access.grant("tool", name, this.#fingerprint(tool));
	}

	revoke(name?: string): void {
		this.#access.revoke("tool", name);
	}

	clearJobs(): void {
		this.#invalidate();
		this.#jobRevision++;
		this.#jobs.clear();
	}

	recordJob(sessionId: string, name: string, output: AgentToolResult<unknown>): void {
		if (
			name !== "bash" ||
			!this.#available(name) ||
			sessionId !== this.#state.sessionId ||
			!resourceDisabled(this.#state.config, "tool:bash")
		)
			return;
		const details = output.details;
		if (details !== null && typeof details === "object" && "job" in details) {
			const job = details.job;
			if (job !== null && typeof job === "object" && "id" in job && typeof job.id === "string")
				this.#jobs.add(job.id);
		}
	}

	close(): void {
		this.#closed = true;
		this.revoke();
		this.clearJobs();
		if (this.#ownsAccess) this.#access.close();
	}

	async execute(
		id: string,
		input: ToolAccessRequest,
		signal: AbortSignal | undefined,
		update: AgentToolUpdateCallback | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		const tool = this.#tool(input.tool);
		if (
			typeof input.reason !== "string" ||
			input.arguments === null ||
			typeof input.arguments !== "object" ||
			Array.isArray(input.arguments)
		)
			throw new Error("工具申请需要理由和参数对象");
		const request: ToolAccessRequest = {
			tool: tool.name,
			reason: input.reason,
			arguments: structuredClone(
				validateToolArguments(tool, {
					type: "toolCall",
					id,
					name: tool.name,
					arguments: structuredClone(input.arguments),
				}),
			),
		};
		const fingerprint = this.#fingerprint(tool);
		const operationSignal = AbortSignal.any([
			this.#invalidated.signal,
			this.#access.signal,
			...(signal ? [signal] : []),
		]);
		const revision = this.#revision;
		const accessRevision = this.#access.revision;
		const policyRevision = this.#state.policy.revision;
		const jobRevision = this.#jobRevision;
		const sessionId = this.#state.sessionId;
		const assertCurrent = () => {
			operationSignal.throwIfAborted();
			this.#tool(tool.name);
			if (
				revision !== this.#revision ||
				accessRevision !== this.#access.revision ||
				fingerprint !== this.#fingerprint(tool)
			)
				throw new Error("工具授权已变更，请重新申请");
			this.#state.policy.assertCurrent(policyRevision);
			this.#checkMcpScope(request);
		};
		assertCurrent();
		if (!this.allows(tool.name, request.arguments)) {
			const approved = await this.#access.request(
				{
					kind: "tool",
					key: tool.name,
					fingerprint,
					label: tool.label,
					reason: request.reason,
					details: { arguments: request.arguments },
				},
				operationSignal,
			);
			if (approved === "deny") throw new Error("工具申请被拒绝；未获得临时使用权限");
		}
		assertCurrent();
		const output = await tool.execute(id, request.arguments, operationSignal, update, ctx);
		if (jobRevision === this.#jobRevision) this.recordJob(sessionId, tool.name, output);
		return output;
	}

	#available(name: string): boolean {
		return (
			!this.#closed &&
			!this.#state.light &&
			this.#tools.has(name) &&
			(!mcpTools.has(name) ||
				Object.keys(this.#state.config.mcpServers).length > 0 ||
				(this.#state.mcpAccess?.list().length ?? 0) > 0)
		);
	}

	#hasGrant(name: string): boolean {
		const tool = this.#tools.get(name);
		return tool !== undefined && this.#access.has("tool", name, this.#fingerprint(tool));
	}

	#fingerprint(tool: ToolDefinition): string {
		return digest(
			JSON.stringify({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
			}),
		);
	}

	#tool(name: string): ToolDefinition {
		const tool = this.#tools.get(name);
		if (!tool || !this.#available(name)) throw new Error(`当前运行不能申请此工具：${name}`);
		return tool;
	}

	#checkMcpScope(request: ToolAccessRequest): void {
		if (request.tool !== "mcp_call" && request.tool !== "mcp_list") return;
		const server = request.arguments.server;
		if (
			server !== undefined &&
			(typeof server !== "string" ||
				(!Object.hasOwn(this.#state.config.mcpServers, server) && !this.#state.mcpAccess?.available(server)))
		)
			throw new Error("MCP 服务不在当前预设选择的范围内");
	}

	#invalidate(): void {
		this.#revision++;
		this.#invalidated.abort(new Error("工具授权已变更，请重新申请"));
		this.#invalidated = new AbortController();
	}
}
