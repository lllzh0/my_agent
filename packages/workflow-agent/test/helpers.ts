import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config/config";

export interface WireRequest {
	model: string;
	messages: { role: string; content: unknown }[];
	tools?: { function: { name: string } }[];
}
export interface WireReply {
	call?: { name: string; arguments: unknown };
	text?: string;
	delayMs?: number;
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function fixture(homeInsideWorkspace = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-product-host-"));
	const cwd = path.join(root, "workspace");
	const home = path.join(homeInsideWorkspace ? cwd : root, "home");
	await fs.mkdir(cwd);
	const requests: WireRequest[] = [];
	const requestHeaders: { sessionId: string | null; userAgent: string | null; authorization: string | null }[] = [];
	let toolCall: { name: string; arguments: unknown } | undefined;
	let toolSequence: { name: string; arguments: unknown }[] | undefined;
	let toolPrompt: string | undefined;
	let failAfterTools: number | undefined;
	let modelFailure: { status: number; message: string } | undefined;
	let stallAfterTool = false;
	let stallChild = false;
	let reviewReply = "uncertain";
	let responder: ((request: WireRequest, sessionId: string | null) => WireReply | undefined) | undefined;
	let rootSession: string | null | undefined;
	const savedRootSessions = new Set<string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requestHeaders.push({
				sessionId: request.headers.get("x-opencode-session"),
				userAgent: request.headers.get("user-agent"),
				authorization: request.headers.get("authorization"),
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
			const reviewing = request.headers.get("x-opencode-session")?.endsWith(":review") === true;
			if (!reviewing && rootSession === undefined) rootSession = request.headers.get("x-opencode-session");
			const eligible =
				(request.headers.get("x-opencode-session") === rootSession ||
					savedRootSessions.has(request.headers.get("x-opencode-session") ?? "")) &&
				(!toolPrompt ||
					JSON.stringify(body.messages.findLast(message => message.role === "user")?.content).includes(
						toolPrompt,
					));
			const reply = responder?.(body, request.headers.get("x-opencode-session"));
			const call = reply
				? reply.call
				: reviewing || !eligible
					? undefined
					: toolSequence
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
				: {
						role: "assistant",
						reasoning_content: "",
						content: reply?.text ?? (reviewing ? reviewReply : "LOCAL_PRODUCT_OK"),
					};
			const base = { id: "product", object: "chat.completion.chunk", created: 1, model: body.model };
			const childStalled =
				stallChild &&
				JSON.stringify(body.messages.findLast(message => message.role === "user")?.content).includes("STALL_CHILD");
			if (childStalled) await Bun.write(path.join(home, "child-request-received"), "ready");
			if (childStalled || (stallAfterTool && body.messages.some(message => message.role === "tool"))) {
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
			if (reply?.delayMs) await Bun.sleep(reply.delayMs);
			return new Response(
				[
					{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
					{
						...base,
						choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
						...(reply?.usage ? { usage: reply.usage } : {}),
					},
				]
					.map(frame => `data: ${JSON.stringify(frame)}\n\n`)
					.join("") + "data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const config: Config = {
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
		respond(callback: (request: WireRequest, sessionId: string | null) => WireReply | undefined) {
			responder = callback;
		},
		callTool(name: string, args: unknown) {
			toolCall = { name, arguments: args };
		},
		callTools(calls: { name: string; arguments: unknown }[], prompt?: string) {
			toolSequence = calls;
			toolPrompt = prompt;
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
		stallChild() {
			stallChild = true;
		},
		reviewReply(value: string) {
			reviewReply = value;
		},
		async cli(args: string[], prompt = "Create the requested file") {
			rootSession = undefined;
			await Bun.write(path.join(home, "config.json"), JSON.stringify(config));
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../src/launcher.ts"),
					"--home",
					home,
					"--cwd",
					cwd,
					"--print",
					"--prompt",
					prompt,
					...args,
				],
				{
					env: { PATH: process.env.PATH, HOME: os.homedir(), TERM: "dumb", PRODUCT_TEST_KEY: "local-fixture-key" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, code };
		},
		async run(
			options: {
				preset?: string;
				light?: boolean;
				approve?: boolean | "connect";
				plan?: boolean;
				testKey?: string;
				testMcpTimeout?: string;
				planOnApproval?: "connect" | "call";
				resume?: string;
				action?: string;
				modelScenario?: "pre" | "post" | "rollback" | "transition";
				newScenario?: "switch-failure" | "post-switch-failure" | "cancelled" | "late-cancelled" | "guarded";
				inputSource?: "interactive" | "extension";
				command?: string;
				commands?: string[];
				promptAfterCommands?: string;
				promptsBefore?: string[];
				resumeSelection?: string;
				resumeScenario?:
					| "busy"
					| "switch-failure"
					| "post-switch-failure"
					| "input-during-switch"
					| "retry-key-during-switch";
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
			rootSession = undefined;
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
						PRODUCT_TEST_KEY_B: "fake-second-key",
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
			if (typeof result?.stateSessionId === "string") savedRootSessions.add(result.stateSessionId);
			return { code, stdout, stderr, result };
		},
		async close() {
			server.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
