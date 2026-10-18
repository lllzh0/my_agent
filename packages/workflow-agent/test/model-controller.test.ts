import { expect, test } from "bun:test";
import { CLI_THINKING_LEVELS } from "@oh-my-pi/pi-tui/thinking";
import { completeSimple, resolvedApiKeyBearer } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { defaultConfig } from "../src/config/config";
import { ProductModels } from "../src/models/controller";
import { Policy } from "../src/policy/policy";
import type { RunState } from "../src/runtime/state";

async function owner() {
	process.env.PRODUCT_BINDING_A = "binding-a-frozen";
	process.env.PRODUCT_BINDING_B = "binding-b-frozen";
	const state = {
		config: {
			...defaultConfig(),
			model: {
				provider: "local-fixture",
				id: "test-model",
				key: "a",
				apiKeyEnv: "PRODUCT_BINDING_A",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				input: ["text"],
				contextWindow: 32000,
				maxTokens: 4096,
			},
			models: [
				{
					provider: "local-fixture",
					id: "test-model",
					key: "b",
					apiKeyEnv: "PRODUCT_BINDING_B",
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:2/v1",
					input: ["text"],
					contextWindow: 32000,
					maxTokens: 4096,
				},
			],
		},
		policy: new Policy("/tmp", { readRoots: [], writeRoots: [], allowNetwork: true }),
		jobs: { hasActiveJobs: false },
	} as RunState;
	const settings = await Settings.init({
		cwd: "/tmp",
		agentDir: "/tmp",
		inMemory: true,
		discoverProjectSettings: false,
	});
	return { state, models: new ProductModels(state, settings), settings };
}

test("bindings reject mismatched endpoint/API and ambient models across native auth entry points", async () => {
	const { models } = await owner();
	const a = models.bind({ model: "a" });
	const b = models.bind({ model: "b" });
	try {
		expect(models.list().map(choice => choice.key)).toEqual(["a", "b"]);
		expect(a.registry.getAvailable()).toEqual([a.model]);
		expect(a.registry.find("openai", "gpt-4o")).toBeUndefined();
		expect(a.registry.getProviderModels("openai")).toEqual([]);
		expect(a.registry.hasProvider("openai")).toBe(false);
		expect(a.registry.getAvailableForProviders(new Set(["openai"]))).toEqual([]);
		expect(await a.registry.getApiKey(b.model)).toBeUndefined();
		expect(a.registry.hasConfiguredAuth(b.model)).toBe(false);
		expect(() => a.getApiKey(b.model)).toThrow("不一致");
		expect(() => a.getApiKey({ ...a.model, api: "anthropic-messages" })).toThrow("不一致");
		expect(
			await a.registry.getApiKeyForProvider(a.model.provider, undefined, {
				baseUrl: b.model.baseUrl,
				modelId: b.model.id,
			}),
		).toBeUndefined();
		expect(await a.registry.resolver(b.model)({ lastChance: false, error: undefined })).toBeUndefined();
		process.env.PRODUCT_BINDING_A = "changed-after-bind";
		expect(await a.registry.getApiKey(a.model)).toBe("binding-a-frozen");
		expect(resolvedApiKeyBearer(await a.apiKey({ lastChance: false, error: undefined }))).toBe("binding-a-frozen");
		expect(await a.apiKey({ lastChance: false, error: new Error("401") })).toBeUndefined();
		expect(await a.apiKey({ lastChance: true, error: new Error("401") })).toBeUndefined();
		const abort = new AbortController();
		abort.abort();
		expect(() => a.apiKey({ signal: abort.signal, lastChance: false, error: undefined })).toThrow();
		a.dispose();
		expect(a.registry.getAvailable()).toEqual([]);
		expect(await a.registry.getApiKey(a.model)).toBeUndefined();
	} finally {
		a.dispose();
		b.dispose();
		await models.dispose();
	}
});

test("parallel native maintenance-style requests retain same-provider endpoint and key isolation", async () => {
	const { models } = await owner();
	const wires: { auth: string | null; model: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model: string };
			wires.push({ auth: request.headers.get("authorization"), model: body.model });
			return new Response(
				`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "offline" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const other = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model: string };
			wires.push({ auth: request.headers.get("authorization"), model: body.model });
			return new Response(
				`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "offline" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	try {
		// Fresh owner with explicit endpoints: no global model discovery and no paid API calls.
		const { state, settings, models: unusedOwner } = await owner();
		await unusedOwner.dispose();
		state.config.model.baseUrl = `http://127.0.0.1:${server.port}/v1`;
		state.config.models![0].baseUrl = `http://127.0.0.1:${other.port}/v1`;
		const isolated = new ProductModels(state, settings);
		const a = isolated.bind({ model: "a" });
		const b = isolated.bind({ model: "b" });
		try {
			const responses = await Promise.all(
				[a, b].map(binding =>
					completeSimple(
						binding.model,
						{ messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
						{ apiKey: binding.registry.resolver(binding.model) },
					),
				),
			);
			expect(responses.every(response => response.stopReason === "stop")).toBe(true);
			expect(wires.map(wire => wire.auth).sort()).toEqual(["Bearer binding-a-frozen", "Bearer binding-b-frozen"]);
			expect(wires.every(wire => wire.model === "test-model")).toBe(true);
			expect(isolated.current().key).toBe("a");
		} finally {
			a.dispose();
			b.dispose();
			await isolated.dispose();
		}
	} finally {
		server.stop(true);
		other.stop(true);
		await models.dispose();
	}
});

for (const flag of [
	"hasAdmittedSubmission",
	"isStreaming",
	"isCompacting",
	"isRetrying",
	"hasPostPromptWork",
	"hasActiveEphemeralTurns",
	"queuedMessageCount",
	"jobs",
	"resume",
	"goal",
	"goal-exiting",
])
	test(`model switching refuses ${flag} before touching the native model`, async () => {
		const { state, models } = await owner();
		let calls = 0;
		const session = {
			[flag]: true,
			model: models.activeModel(),
			configuredThinkingLevel: () => undefined,
			setThinkingLevel() {},
			hasPendingAsyncWork: () => false,
			getGoalModeState: () => ({ enabled: flag === "goal", mode: flag === "goal-exiting" ? "exiting" : "active" }),
			setModel: async () => {
				calls++;
			},
		} as unknown as AgentSession;
		if (flag === "jobs") Object.assign(state.jobs, { hasActiveJobs: true });
		if (flag === "resume")
			state.sessions = {
				assertSubmissionAllowed() {
					throw new Error("busy");
				},
			} as unknown as RunState["sessions"];
		models.attach(session, () => async () => ({ decision: "allow", risk: "low", reason: "fixture" }));
		try {
			await expect(models.select("b")).rejects.toThrow();
			expect(calls).toBe(0);
			expect(models.current().key).toBe("a");
		} finally {
			await models.dispose();
		}
	});

test("unsupported non-chat API cannot become an active root connection", async () => {
	const { state, settings, models } = await owner();
	try {
		state.config.model.api = "openai-images";
		expect(() => new ProductModels(state, settings)).toThrow("对话");
	} finally {
		await models.dispose();
	}
});

test("missing custom route and unsupported effort are rejected before binding", async () => {
	const { models } = await owner();
	try {
		expect(() => models.bind({ model: "unconfigured" })).toThrow("未配置");
		expect(() => models.bind({ model: "b", effort: CLI_THINKING_LEVELS.find(level => level === "max")! })).toThrow(
			"强度",
		);
		delete process.env.PRODUCT_BINDING_B;
		expect(() => models.bind({ model: "b" })).toThrow("PRODUCT_BINDING_B");
		expect(models.current().key).toBe("a");
	} finally {
		await models.dispose();
	}
});

test("known-model overrides validate the final combined limits", async () => {
	const { state, settings, models } = await owner();
	try {
		state.config.model = { ...defaultConfig().model, apiKeyEnv: "PRODUCT_BINDING_A", contextWindow: 1 };
		expect(() => new ProductModels(state, settings)).toThrow("maxTokens");
	} finally {
		await models.dispose();
	}
});

test("custom models must explicitly declare a nonempty input capability", async () => {
	const { state, settings, models } = await owner();
	try {
		delete state.config.model.input;
		expect(() => new ProductModels(state, settings)).toThrow("input");
		state.config.model.input = [];
		expect(() => new ProductModels(state, settings)).toThrow("input");
	} finally {
		await models.dispose();
	}
});
