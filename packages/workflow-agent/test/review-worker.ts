import * as path from "node:path";
import { openHost } from "../src/runtime/host";
import { untilAborted } from "@oh-my-pi/pi-utils";

const options = JSON.parse(process.argv[2]) as {
	home: string;
	cwd: string;
	output: string;
	cancel?: boolean;
	recovery?: "new" | "close";
};
const host = await openHost({ home: options.home, cwd: options.cwd });
const review = host.state.review!;
const source = { id: host.state.sessionId, file: host.session.sessionFile!, stateDir: host.state.stateDir };
try {
	const controller = new AbortController();
	const running = review.run(undefined, controller.signal);
	const blocked: string[] = [];
	if (options.cancel) {
		const marker = path.join(options.home, "child-request-received");
		await untilAborted(AbortSignal.timeout(10_000), async () => {
			while (!(await Bun.file(marker).exists())) await Bun.sleep(10);
		});
		for (const action of [
			() => host.session.prompt("SHOULD_BE_BLOCKED"),
			() => host.session.runEphemeralTurn({ promptText: "SHOULD_BE_BLOCKED", tools: false }),
			() => host.state.sessions!.startNew(),
			() => host.state.models!.select(host.state.models!.current().key),
		]) {
			try {
				await action();
				blocked.push("admitted");
			} catch {
				blocked.push("blocked");
			}
		}
		controller.abort();
	}
	const result = await running;
	const stats = await review.stats();
	let recovery: Record<string, unknown> | undefined;
	if (options.recovery) {
		recovery = {
			source,
			rootMessages: host.session.messages,
			fileBefore: await Bun.file(source.file).exists(),
			error: "",
		};
		try {
			if (options.recovery === "new") {
				await host.state.sessions!.startNew();
				recovery.newId = host.state.sessionId;
				recovery.newStats = await host.state.review!.stats();
				recovery.listIds = (await host.state.sessions!.list()).map(session => session.id);
				await host.state.sessions!.resume(source.file);
				recovery.restoredId = host.state.sessionId;
				recovery.restoredStats = await host.state.review!.stats();
				recovery.restoredMessages = host.session.messages;
			} else {
				await host.dispose();
				const reopened = await openHost({ home: options.home, cwd: options.cwd, resume: source.file });
				try {
					recovery.restoredId = reopened.state.sessionId;
					recovery.restoredStats = await reopened.state.review!.stats();
					recovery.restoredMessages = reopened.session.messages;
				} finally {
					await reopened.dispose();
				}
			}
		} catch (error) {
			recovery.error = String(error);
		}
	}
	await Bun.write(options.output, JSON.stringify({ result, stats, busy: review.busy, blocked, recovery }));
} finally {
	await review.close();
	await host.dispose();
}
