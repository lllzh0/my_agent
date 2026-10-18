import { Database } from "bun:sqlite";
import type { ApiKeyResolver, Model, Api, ResolvedApiKey } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore, type AuthApiKeyOptions } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel, isGeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelKind, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry, type ContextWindowTiers } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ApiKeyResolverModel, ApiKeyResolverOptions } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { defaultConfig, validateModelConfig, MODEL_APIS, type ModelConfig } from "../config/config";
import type { Reviewer } from "../policy/policy";
import type { RunState } from "../runtime/state";

export interface ModelChoice {
	key: string;
	label: string;
	provider: string;
	id: string;
	configured: boolean;
}
export interface ModelSelection {
	model: string;
	effort?: ConfiguredThinkingLevel;
}
export interface ModelBinding {
	choice: ModelChoice;
	model: Model;
	getApiKey: NonNullable<CreateAgentSessionOptions["getApiKey"]>;
	apiKey: ApiKeyResolver;
	registry: ModelRegistry;
	auth: AuthStorage;
	effort?: ConfiguredThinkingLevel;
	dispose(): void;
}
interface RequestBinding {
	model: Model;
	key: string;
	apiKey: ApiKeyResolver;
}

function matches(expected: Model, actual: ApiKeyResolverModel & { api?: Api }): boolean {
	return (
		expected.provider === actual.provider &&
		expected.id === actual.id &&
		expected.baseUrl === actual.baseUrl &&
		(actual.api === undefined || expected.api === actual.api)
	);
}

/** A closed native registry: native maintenance requests see this exact binding too. */
class BoundRegistry extends ModelRegistry {
	#binding: RequestBinding;
	#closed = false;
	constructor(binding: RequestBinding, settings: Settings) {
		const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		super(auth, undefined, {
			settings,
			ignoreLocalModelConfig: true,
			fetch: async () => {
				throw new Error("模型自动发现未启用");
			},
		});
		this.#binding = binding;
	}
	setBinding(binding: RequestBinding): void {
		this.#binding = binding;
	}
	close(): void {
		if (!this.#closed) {
			this.#closed = true;
			this.authStorage.close();
		}
	}
	override getAll(kind: ModelKind | "all" = "chat"): Model[] {
		return !this.#closed && (kind === "all" || modelKind(this.#binding.model) === kind) ? [this.#binding.model] : [];
	}
	override getAvailable(kind: ModelKind | "all" = "chat"): Model[] {
		return this.getAll(kind);
	}
	override getAvailableForProviders(providers: ReadonlySet<string>, kind: ModelKind | "all" = "chat"): Model[] {
		return this.getAll(kind).filter(model =>
			[...providers].some(provider => provider.toLowerCase() === model.provider.toLowerCase()),
		);
	}
	override getProviderModels(provider: string): Model[] {
		return this.getAll("all").filter(model => model.provider === provider);
	}
	override hasProvider(provider: string): boolean {
		return this.getProviderModels(provider).length > 0;
	}
	override hasConcreteAuth(provider: string): boolean {
		return this.hasProvider(provider);
	}
	override getProviderBaseUrl(provider: string): string | undefined {
		return this.getProviderModels(provider)[0]?.baseUrl;
	}
	override getDiscoverableProviders(): string[] {
		return [];
	}
	override contextWindowTiers(_model: { provider: string; id: string }): ContextWindowTiers | undefined {
		return undefined;
	}
	override fitContextWindow(model: Model, _scope: Settings): Model {
		return model;
	}
	override find(provider: string, id: string): Model | undefined {
		return !this.#closed && this.#binding.model.provider === provider && this.#binding.model.id === id
			? this.#binding.model
			: undefined;
	}
	override hasConfiguredAuth(model: Model): boolean {
		return !this.#closed && matches(this.#binding.model, model);
	}
	override async refreshSelectedModelMetadata(model: Model): Promise<Model> {
		if (!this.hasConfiguredAuth(model)) throw new Error("模型不在本次明确连接中");
		return this.#binding.model;
	}
	override async hydrateCredentialScopedModelCaches(): Promise<void> {}
	override async refresh(): Promise<void> {}
	override async getApiKey(
		model: Model,
		_sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<string | undefined> {
		options?.signal?.throwIfAborted();
		return this.hasConfiguredAuth(model) ? this.#binding.key : undefined;
	}
	override async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<string | undefined> {
		return (await this.getApiKeyWithCredentialForProvider(provider, sessionId, options))?.apiKey;
	}
	override async getApiKeyWithCredentialForProvider(
		provider: string,
		_sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		options?.signal?.throwIfAborted();
		const model = this.#binding.model;
		if (
			this.#closed ||
			provider !== model.provider ||
			options?.forceRefresh ||
			(options?.baseUrl !== undefined && options.baseUrl !== model.baseUrl) ||
			(options?.modelId !== undefined && options.modelId !== model.id)
		)
			return undefined;
		return { apiKey: this.#binding.key };
	}
	override resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	override resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	override resolver(
		target: string | ApiKeyResolverModel,
		optionsOrSessionId?: ApiKeyResolverOptions | string,
	): ApiKeyResolver {
		const options = typeof optionsOrSessionId === "object" ? optionsOrSessionId : undefined;
		const binding = this.#binding;
		const allowed =
			!this.#closed &&
			(typeof target === "string"
				? target === binding.model.provider &&
					(options?.baseUrl === undefined || options.baseUrl === binding.model.baseUrl) &&
					(options?.modelId === undefined || options.modelId === binding.model.id)
				: matches(binding.model, target));
		return context => {
			context.signal?.throwIfAborted();
			return allowed && !this.#closed ? binding.apiKey(context) : undefined;
		};
	}
}

function modelMetadata(config: ModelConfig): Model {
	const native = isGeneratedProvider(config.provider) ? getBundledModel(config.provider, config.id) : undefined;
	if (!MODEL_APIS.includes(config.api ?? native?.api ?? ""))
		throw new Error("该模型的接口不支持本入口的明确密钥对话连接");
	if (
		!native &&
		(!config.api || !config.baseUrl || !config.contextWindow || !config.maxTokens || !config.input?.length)
	)
		throw new Error(
			`自定义模型 ${config.provider}/${config.id} 必须明确配置 api、baseUrl、contextWindow、maxTokens、input`,
		);
	if (native) {
		const { key: _key, apiKeyEnv: _env, authPath: _auth, ...overrides } = config;
		const merged = {
			...toModelSpec(native),
			...overrides,
			...(config.thinking && config.reasoning === undefined ? { reasoning: true } : {}),
		};
		if (merged.maxTokens !== null && merged.contextWindow !== null && merged.maxTokens > merged.contextWindow)
			throw new Error("模型 maxTokens 不能超过最终 contextWindow");
		// A changed API needs the catalog builder to project the matching wire metadata.
		return config.api !== undefined && config.api !== native.api
			? buildModel(merged)
			: {
					...native,
					...overrides,
					...(config.thinking && config.reasoning === undefined ? { reasoning: true } : {}),
				};
	}
	return buildModel({
		provider: config.provider,
		id: config.id,
		name: config.name ?? config.id,
		api: config.api!,
		baseUrl: config.baseUrl!,
		contextWindow: config.contextWindow!,
		maxTokens: config.maxTokens!,
		reasoning: config.reasoning ?? !!config.thinking,
		thinking: config.thinking,
		input: config.input!,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricingStatus: "unknown",
		isOAuth: false,
	});
}

function validateEffort(model: Model, effort?: ConfiguredThinkingLevel): void {
	if (effort === undefined) return;
	if (
		!model.reasoning ||
		(effort !== "off" && effort !== "auto" && !getSupportedEfforts(model).some(value => value === effort)) ||
		(effort === "auto" && model.thinking?.unverified)
	)
		throw new Error(`模型 ${model.provider}/${model.id} 不支持所选思考强度`);
}

export class ProductModels {
	#state: RunState;
	#settings: Settings;
	#configs: ModelConfig[];
	#requests = new WeakMap<ModelBinding, RequestBinding>();
	#active: ModelBinding;
	#session?: AgentSession;
	#reviewer?: (binding: ModelBinding) => Reviewer;
	#root: BoundRegistry;
	#demoKey?: string;
	#blocked = false;
	#closed = false;
	#pending?: Promise<void>;
	busy = false;
	readonly registry: ModelRegistry;
	readonly auth: AuthStorage;
	readonly getApiKey: NonNullable<CreateAgentSessionOptions["getApiKey"]> = model => {
		if (!this.#root.hasConfiguredAuth(model)) throw new Error("请求模型与明确连接不一致");
		return this.#root.resolver(model);
	};
	constructor(state: RunState, settings: Settings, demoPort?: number) {
		this.#state = state;
		this.#settings = settings;
		this.#demoKey = demoPort ? "offline-local-placeholder" : undefined;
		this.#configs = demoPort
			? [{ ...defaultConfig().model, name: "离线演示", baseUrl: `http://127.0.0.1:${demoPort}/v1` }]
			: [state.config.model, ...(state.config.models ?? [])];
		this.#configs = this.#configs.map(config => validateModelConfig(structuredClone(config), "model"));
		const keys = this.#configs.map(config => config.key ?? `${config.provider}/${config.id}`);
		if (new Set(keys).size !== keys.length) throw new Error("模型连接 key 重复");
		if (this.#configs.some(config => config.authPath))
			throw new Error("本入口暂只使用密钥环境变量，不直接导入旧 Pi 凭据文件；请移除 model.authPath。");
		this.#active = this.bind({ model: keys[0] });
		this.#root = new BoundRegistry(this.#request(this.#active), settings);
		this.registry = this.#root;
		this.auth = this.#root.authStorage;
	}
	#request(binding: ModelBinding): RequestBinding {
		return this.#requests.get(binding)!;
	}

	list(): readonly ModelChoice[] {
		return this.#configs.map(config => ({
			key: config.key ?? `${config.provider}/${config.id}`,
			label: config.name ?? `${config.provider}/${config.id}`,
			provider: config.provider,
			id: config.id,
			configured: !!(this.#demoKey ?? process.env[config.apiKeyEnv])?.trim(),
		}));
	}
	current(): ModelChoice {
		return { ...this.#active.choice };
	}
	activeModel(): Model {
		return this.#active.model;
	}
	rootBinding(): ModelBinding {
		return this.#active;
	}
	bind(selection?: ModelSelection): ModelBinding {
		if (this.#closed) throw new Error("模型连接已关闭");
		const key = selection?.model ?? this.current().key;
		const choice = this.list().find(choice => choice.key === key);
		if (!choice) throw new Error(`未配置模型连接 ${key}`);
		const config = this.#configs.find(config => (config.key ?? `${config.provider}/${config.id}`) === key)!;
		const secret = this.#demoKey ?? process.env[config.apiKeyEnv];
		if (!secret?.trim()) throw new Error(`缺少模型密钥环境变量 ${config.apiKeyEnv}`);
		const model = modelMetadata(config);
		const effort = selection?.effort;
		validateEffort(model, effort);
		const apiKey: ApiKeyResolver = context => {
			context.signal?.throwIfAborted();
			return context.error === undefined ? secret : undefined;
		};
		const registry = new BoundRegistry({ model, key: secret, apiKey }, this.#settings);
		const binding: ModelBinding = {
			choice,
			model,
			apiKey,
			registry,
			auth: registry.authStorage,
			effort,
			getApiKey: request => {
				if (!registry.hasConfiguredAuth(request)) throw new Error("请求模型与明确连接不一致");
				return registry.resolver(request);
			},
			dispose: () => registry.close(),
		};
		this.#requests.set(binding, { model, key: secret, apiKey });
		return binding;
	}
	attach(session: AgentSession, reviewer: (binding: ModelBinding) => Reviewer): void {
		this.#session = session;
		this.#reviewer = reviewer;
	}
	rebindReviewer(): void {
		if (this.#reviewer) this.#state.policy.setReviewer(this.#reviewer(this.#active));
	}
	assertSubmissionAllowed(): void {
		if (this.#closed || this.#blocked) throw new Error("模型连接已关闭或切换回退失败；请退出后重新打开会话。");
		if (this.busy) throw new Error("正在切换模型，请稍后再输入。");
	}
	#assertIdle(): void {
		const session = this.#session;
		if (!session) throw new Error("会话尚未初始化");
		this.#state.sessions?.assertSubmissionAllowed();
		this.#state.review?.assertSubmissionAllowed();
		if (
			session.hasActiveEphemeralTurns ||
			session.hasAdmittedSubmission ||
			session.isStreaming ||
			session.isCompacting ||
			session.isRetrying ||
			session.hasPostPromptWork ||
			session.queuedMessageCount ||
			session.hasPendingAsyncWork() ||
			session.isSessionTransitioning
		)
			throw new Error("会话仍在运行或有排队消息；先停止后再切换模型。");
		if (session.getGoalModeState()?.enabled || session.getGoalModeState()?.mode === "exiting")
			throw new Error("目标仍在执行；先用 /goal pause 暂停，再切换模型。");
		if (this.#state.jobs.hasActiveJobs) throw new Error("后台任务仍在运行或等待批准；先停止任务再切换模型。");
	}
	async select(key: string, effort?: ConfiguredThinkingLevel): Promise<void> {
		this.assertSubmissionAllowed();
		this.#assertIdle();
		const next = this.bind({ model: key, effort });
		let reviewer: Reviewer | undefined;
		try {
			reviewer = this.#reviewer?.(next);
		} catch {
			next.dispose();
			throw new Error("新模型审核器初始化失败，原连接已保留。");
		}
		this.busy = true;
		this.#pending = this.#switch(next, reviewer);
		return this.#pending;
	}
	async #switch(next: ModelBinding, reviewer?: Reviewer): Promise<void> {
		const session = this.#session!;
		const previous = this.#active;
		const previousRequest = this.#request(previous);
		const previousModel = session.model ?? previous.model;
		const previousEffort = session.configuredThinkingLevel();
		try {
			this.#root.setBinding(this.#request(next));
			await session.setModel(next.model, "default", { persist: false });
			session.setThinkingLevel(next.effort, false);
		} catch {
			this.#root.setBinding(previousRequest);
			try {
				if (session.model !== previousModel) await session.setModel(previousModel, "default", { persist: false });
				session.setThinkingLevel(previousEffort, false);
			} catch {
				this.#blocked = true;
				throw new Error("模型切换失败且旧连接恢复失败；已阻止后续提交，请退出后重新打开会话。");
			} finally {
				next.dispose();
			}
			throw new Error("模型切换失败，已恢复原模型、凭据和思考强度。");
		} finally {
			this.busy = false;
			this.#pending = undefined;
		}
		this.#active = next;
		if (reviewer) this.#state.policy.setReviewer(reviewer);
		previous.dispose();
	}
	async dispose(): Promise<void> {
		this.#closed = true;
		await this.#pending?.catch(() => {});
		this.#active.dispose();
		this.#root.close();
	}
}
