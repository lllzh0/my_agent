import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface WireRequest {
	model: string;
	messages: { role: string; content: unknown }[];
	tools?: { function: { name: string } }[];
}

export async function fixture(homeInsideWorkspace = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-product-host-"));
	const cwd = path.join(root, "workspace");
	const home = path.join(homeInsideWorkspace ? cwd : root, "home");
	await fs.mkdir(cwd);
	const requests: WireRequest[] = [];
	const requestHeaders: { sessionId: string | null; userAgent: string | null }[] = [];
	let toolCall: { name: string; arguments: unknown } | undefined;
	let toolSequence: { name: string; arguments: unknown }[] | undefined;
	let failAfterTools: number | undefined;
	let modelFailure: { status: number; message: string } | undefined;
	let stallAfterTool = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requestHeaders.push({
				sessionId: request.headers.get("x-opencode-session"),
				userAgent: request.headers.get("user-agent"),
			});
			const body = (await request.json()) as WireRequest;
			requests.push(body);
			const toolResults = body.messages.filter(message => message.role === "tool").length;
			const failure =
				modelFailure ??
				(toolResults === failAfterTools ? { status: 401, message: "fixture failed after tool" } : undefined);
			if (failure)
				return Response.json(
					{ error: { message: failure.message, type: "fixture_error" } },
					{ status: failure.status },
				);
			const call = toolSequence
				? toolSequence[toolResults]
				: toolCall && !body.messages.some(message => message.role === "tool")
					? toolCall
					: undefined;
			const delta = call
				? {
						role: "assistant",
						reasoning_content: "",
						tool_calls: [
							{
								index: 0,
								id: toolSequence ? `call_product_${toolResults}` : "call_product",
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							},
						],
					}
				: { role: "assistant", reasoning_content: "", content: "LOCAL_PRODUCT_OK" };
			const base = { id: "product", object: "chat.completion.chunk", created: 1, model: body.model };
			if (stallAfterTool && body.messages.some(message => message.role === "tool")) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "..." }, finish_reason: null }], private_detail: "PRIVATE_STREAM_DETAIL" })}\n\n: keepalive\n\n`,
								),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(
				[
					{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
				]
					.map(frame => `data: ${JSON.stringify(frame)}\n\n`)
					.join("") + "data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const config = {
		version: 1,
		model: {
			provider: "opencode-go",
			id: "deepseek-v4.1-flash",
			apiKeyEnv: "PRODUCT_TEST_KEY",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		},
		resources: {
			instructions: [] as string[],
			skills: [] as string[],
			extensions: [] as { path: string; enabled: boolean }[],
			appendSystem: [],
		},
		permissions: { readRoots: [], writeRoots: [], allowNetwork: false },
		search: { provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5 },
		sandbox: { required: true, allowedDomains: [] },
		mcpServers: {} as Record<string, unknown>,
	};
	return {
		root,
		cwd,
		home,
		config,
		requests,
		requestHeaders,
		callTool(name: string, args: unknown) {
			toolCall = { name, arguments: args };
		},
		callTools(calls: { name: string; arguments: unknown }[]) {
			toolSequence = calls;
		},
		failAfterTools(count: number | undefined) {
			failAfterTools = count;
		},
		failModel(status: number, message: string) {
			modelFailure = { status, message };
		},
		recoverModel() {
			modelFailure = undefined;
		},
		stallAfterTool() {
			stallAfterTool = true;
		},
		async run(
			options: {
				light?: boolean;
				approve?: boolean | "connect";
				plan?: boolean;
				testKey?: string;
				testMcpTimeout?: string;
				planOnApproval?: "connect" | "call";
				resume?: string;
				action?: string;
				command?: string;
				commands?: string[];
				promptAfterCommands?: string;
				undoScenario?:
					| "normal"
					| "conflict"
					| "plan-after-approval"
					| "queued-plan"
					| "pending-job"
					| "late-plan"
					| "slow-ui";
				cwd?: string;
			} = {},
		) {
			await Bun.write(path.join(home, "config.json"), JSON.stringify(config));
			const resultFile = path.join(root, "result.json");
			await fs.rm(resultFile, { force: true });
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "host-worker.ts"),
					JSON.stringify({ home, cwd, resultFile, ...options }),
				],
				{
					cwd,
					env: {
						PATH: process.env.PATH,
						HOME: os.homedir(),
						TERM: "dumb",
						PRODUCT_TEST_KEY: options.testKey ?? "fake-local-key",
						PI_CONFIG_DIR: path.relative(os.homedir(), path.join(home, "omp")),
						PI_CODING_AGENT_DIR: path.join(home, "omp/agent"),
						PI_NATIVES_DIR: path.join(home, "natives"),
						OMP_PROFILE: "",
						PI_PROFILE: "",
						OMP_APP_NAME: "my-agent",
						OMP_MCP_TIMEOUT_MS: options.testMcpTimeout,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			const result = (await Bun.file(resultFile).exists()) ? await Bun.file(resultFile).json() : undefined;
			return { code, stdout, stderr, result };
		},
		async close() {
			server.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
