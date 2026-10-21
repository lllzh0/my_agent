import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Policy } from "../policy/policy";
import type { RunState } from "../runtime/state";
import { productTools } from "../runtime/tools";
import { resourceDisabled } from "../runtime/resources";
import { atomicJson, readJson, record, redact } from "../storage";
import { collectProductDiff, type ProductDiffSnapshot } from "./diff";
import systemPrompt from "../prompts/review/system.md" with { type: "text" };
import taskPrompt from "../prompts/review/task.md" with { type: "text" };

export interface ReviewUsage {
	reviews: number;
	requests: number;
	tokens: number;
	cost: number;
	elapsedMs: number;
}
export interface ProductReviewResult {
	snapshot: ProductDiffSnapshot;
	output: string;
	requests: number;
	tokens: number;
	cost: number;
	elapsedMs: number;
	partial: boolean;
	cancelled: boolean;
	error?: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_REQUESTS = 6;

export class ProductReview {
	readonly #state: RunState;
	readonly #session: AgentSession;
	#controller?: AbortController;
	#pending?: Promise<ProductReviewResult>;
	#closed = false;
	get busy(): boolean {
		return this.#pending !== undefined;
	}
	constructor(state: RunState, session: AgentSession) {
		this.#state = state;
		this.#session = session;
	}
	assertSubmissionAllowed(): void {
		if (this.busy) throw new Error("正在审查代码；请等待完成或先取消审查。");
		if (this.#closed) throw new Error("审查运行时正在关闭。");
	}
	async stats(): Promise<ReviewUsage> {
		const data = await readJson(path.join(this.#state.stateDir, "review-usage.json"));
		const usage: ReviewUsage = { reviews: 0, requests: 0, tokens: 0, cost: 0, elapsedMs: 0 };
		if (data) {
			const saved = record(data, "审查统计");
			for (const key of ["reviews", "requests", "tokens", "cost", "elapsedMs"] as const) {
				const value = saved[key];
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("审查统计已损坏");
				usage[key] = value;
			}
		}
		return usage;
	}
	async close(): Promise<void> {
		this.#closed = true;
		this.#controller?.abort();
		await this.#pending?.catch(() => {});
	}
	cancel(): void {
		this.#controller?.abort();
	}
	run(base?: string, signal?: AbortSignal): Promise<ProductReviewResult> {
		this.#state.liveResources?.assertSubmissionAllowed();
		this.assertSubmissionAllowed();
		const state = this.#state;
		const session = this.#session;
		if (
			state.models?.busy ||
			state.sessions?.busy ||
			state.sessions?.closed ||
			state.jobs.hasActiveJobs ||
			session.isStreaming ||
			session.isCompacting ||
			session.isRetrying ||
			session.queuedMessageCount ||
			session.hasPostPromptWork ||
			session.hasPendingAsyncWork() ||
			session.hasAdmittedSubmission ||
			session.isSessionTransitioning ||
			session.hasActiveEphemeralTurns ||
			session.getGoalModeState()?.mode === "exiting" ||
			session.getGoalModeState()?.enabled
		)
			throw new Error("会话、目标或后台任务仍在运行；停止后再审查。");
		this.#controller = new AbortController();
		const operation = AbortSignal.any([this.#controller.signal, ...(signal ? [signal] : [])]);
		this.#pending = this.#run(base, operation).finally(() => {
			this.#controller = undefined;
			this.#pending = undefined;
		});
		return this.#pending;
	}
	async #run(base: string | undefined, signal: AbortSignal): Promise<ProductReviewResult> {
		const state = this.#state;
		const started = Date.now();
		const snapshot = await collectProductDiff(state, base, signal);
		if (!snapshot.files.length)
			return {
				snapshot,
				output: snapshot.complete ? "没有需要审查的差异。" : "没有可供审查的文本；请检查未覆盖清单。",
				requests: 0,
				tokens: 0,
				cost: 0,
				elapsedMs: Date.now() - started,
				partial: !snapshot.complete,
				cancelled: false,
			};
		if (!state.models) throw new Error("模型管理尚未初始化。");
		const binding = state.models.bind();
		const policy = new Policy(state.cwd, structuredClone(state.policy.settings));
		policy.protectedRoots = [state.home, ...state.policy.protectedRoots];
		policy.mode = "plan";
		const context: ToolSession = {
			cwd: state.cwd,
			settings: this.#session.settings,
			hasUI: false,
			enableLsp: false,
			enableMCP: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getActiveModel: () => binding.model,
			hasEditTool: false,
		};
		const childState: RunState = { ...state, policy };
		const tools = productTools(childState, context).filter(
			tool => READ_TOOLS.has(tool.name) && !resourceDisabled(state.config, `tool:${tool.name}`),
		);
		const cleanups: Promise<void>[] = [];
		let startedRequests = 0;
		let exhausted = false;
		try {
			const output = await runSubprocess({
				cwd: state.cwd,
				id: Bun.randomUUIDv7(),
				index: 0,
				description: "只读代码审查",
				task: prompt.render(taskPrompt, { snapshot: JSON.stringify(snapshot) }),
				agent: {
					name: "product-review",
					description: "只读代码审查",
					source: "project",
					systemPrompt,
					tools: tools.map(tool => tool.name),
					thinkingLevel: binding.effort ?? this.#session.configuredThinkingLevel(),
				},
				explicitModel: binding.model,
				modelOverride: `${binding.model.provider}/${binding.model.id}`,
				getApiKey: binding.getApiKey,
				authStorage: binding.auth,
				modelRegistry: binding.registry,
				settings: this.#session.settings.overlay({
					"task.agentSoftRequestBudget": { "product-review": 2 },
					"task.softRequestBudgetNotice": true,
					"retry.enabled": false,
				}),
				keepAlive: false,
				structured: false,
				hostSystemPrompt: systemPrompt,
				persistArtifacts: true,
				artifactsDir: path.join(state.stateDir, "reviews"),
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				customTools: tools.map(tool => ({ ...tool, __isToolDefinition: true })),
				contextFiles: [],
				skills: [],
				rules: [],
				promptTemplates: [],
				preloadedExtensionPaths: [],
				preloadedCustomToolPaths: [],
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				workspaceTree: { rootPath: state.cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
				signal,
				maxRuntimeMs: 120_000,
				beforeModelCall() {
					if (startedRequests >= MAX_REQUESTS) {
						exhausted = true;
						return { stop: true, reason: "审查请求预算已用完" };
					}
					startedRequests++;
				},
				onCleanupDeferred: completion => {
					cleanups.push(completion);
				},
			}).finally(async () => {
				await Promise.allSettled(cleanups);
			});
			const result: ProductReviewResult = {
				snapshot,
				output: String(redact(output.output)),
				requests: Math.min(startedRequests, output.requests ?? 0),
				tokens: output.tokens ?? 0,
				cost: output.usage?.cost.total ?? 0,
				elapsedMs: Date.now() - started,
				partial:
					!snapshot.complete ||
					exhausted ||
					startedRequests >= 3 ||
					output.aborted === true ||
					output.exitCode !== 0,
				cancelled: output.aborted === true && !exhausted,
				error: exhausted
					? "审查请求预算已用完"
					: (output.error ?? (output.exitCode !== 0 ? String(redact(output.stderr)) : undefined)),
			};
			const usage = await this.stats();
			usage.reviews++;
			usage.requests += result.requests;
			usage.tokens += result.tokens;
			usage.cost += result.cost;
			usage.elapsedMs += result.elapsedMs;
			await atomicJson(path.join(state.stateDir, "review-usage.json"), usage);
			await atomicJson(path.join(state.stateDir, "reviews", `${Bun.randomUUIDv7()}.json`), result);
			return result;
		} finally {
			binding.dispose();
		}
	}
}
