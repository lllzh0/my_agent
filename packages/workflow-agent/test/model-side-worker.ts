import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openHost } from "../src/runtime/host";
import { defaultConfig } from "../src/config/config";

const options = JSON.parse(process.argv[2]) as { home: string; cwd: string; resultFile: string; scenario: string };
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let requests = 0;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as { model: string; messages: unknown[] };
		requests++;
		if (JSON.stringify(body.messages).includes("HOLD_SIDE")) {
			entered.resolve();
			await release.promise;
		}
		const base = { id: "side", object: "chat.completion.chunk", created: 1, model: body.model };
		return new Response(
			[
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "SIDE_OK" }, finish_reason: null }] },
				{
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
			]
				.map(event => `data: ${JSON.stringify(event)}\n\n`)
				.join("") + "data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});
process.env.PRODUCT_SIDE_KEY = "offline-side-key";
const config = defaultConfig();
config.model = {
	...config.model,
	key: "a",
	baseUrl: `http://127.0.0.1:${server.port}/v1`,
	apiKeyEnv: "PRODUCT_SIDE_KEY",
};
config.models = [{ ...config.model, key: "b", baseUrl: `http://127.0.0.1:${server.port}/second/v1` }];
await fs.mkdir(options.cwd, { recursive: true });
await Bun.write(path.join(options.home, "config.json"), JSON.stringify(config));
const host = await openHost(options);
try {
	const models = host.state.models!;
	const session = host.session;
	const result: Record<string, unknown> = {};
	if (options.scenario === "complete" || options.scenario === "abort") {
		const abort = new AbortController();
		const timeout = setTimeout(() => {
			entered.reject(new Error("side request never entered localhost"));
			abort.abort();
		}, 8000);
		const side = session.runEphemeralTurn({ promptText: "HOLD_SIDE", tools: false, signal: abort.signal }).then(
			value => value.replyText,
			error => String(error),
		);
		try {
			await entered.promise;
			result.activeWhileHeld = session.hasActiveEphemeralTurns;
			const previousId = host.state.sessionId;
			const previousFile = session.sessionFile;
			const previousFiles = await fs.readdir(path.join(options.home, "sessions"));
			for (const [key, operation] of [
				["model", () => models.select("b")],
				["new", () => host.state.sessions!.startNew()],
				["review", () => host.state.review!.run()],
			] as const) {
				try {
					await operation();
					result[`${key}Blocked`] = false;
				} catch {
					result[`${key}Blocked`] = true;
				}
			}
			result.identityPreserved = previousId === host.state.sessionId && previousFile === session.sessionFile;
			result.filesPreserved =
				JSON.stringify(previousFiles) === JSON.stringify(await fs.readdir(path.join(options.home, "sessions")));
			if (options.scenario === "abort") abort.abort();
			else release.resolve();
			result.sideResult = await side;
			result.activeAfter = session.hasActiveEphemeralTurns;
			await models.select("b");
			result.selectedAfter = models.current().key;
		} finally {
			clearTimeout(timeout);
			abort.abort();
			release.resolve();
			await side;
		}
	} else {
		const native = session.setModel.bind(session);
		let attempts = 0;
		session.setModel = async (model, role, switchOptions) => {
			attempts++;
			if (options.scenario === "rollback") {
				if (attempts === 1) await native(model, role, switchOptions);
				throw new Error("fixture rollback failure");
			}
			try {
				await session.runEphemeralTurn({ promptText: "MUST_NOT_REQUEST", tools: false });
				result.admittedWhileLocked = true;
			} catch (error) {
				result.lockError = String(error);
				result.admittedWhileLocked = false;
			}
			result.activeDuringLock = session.hasActiveEphemeralTurns;
			return native(model, role, switchOptions);
		};
		try {
			await models.select("b");
		} catch (error) {
			result.switchError = String(error);
		}
		if (options.scenario === "rollback") {
			try {
				await session.runEphemeralTurn({ promptText: "MUST_NOT_REQUEST", tools: false });
				result.admittedAfterRollback = true;
			} catch (error) {
				result.rollbackError = String(error);
				result.admittedAfterRollback = false;
			}
		}
		result.activeAfter = session.hasActiveEphemeralTurns;
	}
	result.requests = requests;
	await Bun.write(options.resultFile, JSON.stringify(result));
} finally {
	release.resolve();
	await host.dispose();
	server.stop(true);
}
