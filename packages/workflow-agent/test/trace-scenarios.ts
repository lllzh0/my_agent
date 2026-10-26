import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Host } from "../src/runtime/host";

export async function traceScenario(host: Host, scenario: string): Promise<unknown> {
	const { state, session } = host;
	const traces = state.traces!;
	const command = (text: string) => session.extensionRunner!.emitInput(text, undefined, "interactive");
	if (scenario === "lifecycle") {
		await command("/trace on");
		await session.prompt("TRACE_FIRST");
		await command("/resources off tool:read");
		await session.prompt("TRACE_SECOND");
		const before = await traces.list();
		await command(`/trace compare ${before[0].id} ${before[1].id}`);
		await command("/trace off");
		await session.prompt("TRACE_AFTER_OFF");
		const oldId = state.sessionId;
		const oldPath = state.stateDir;
		await state.sessions!.startNew();
		const empty = await traces.list();
		await command("/trace on");
		await session.prompt("TRACE_NEW_SESSION");
		return { oldId, oldPath, oldCount: before.length, newRecords: await traces.list(), empty };
	}
	if (scenario === "cancel") {
		await command("/trace on");
		const running = session.prompt("TRACE_CANCEL");
		while ((await traces.list()).length < 2) await Bun.sleep(10);
		await session.abort();
		await running;
		return await traces.list();
	}
	if (scenario === "concurrent") {
		await command("/trace on");
		await Promise.all([
			session.prompt("TRACE_MAIN_CONCURRENT"),
			session.runEphemeralTurn({ promptText: "TRACE_SIDE_CONCURRENT", tools: false }),
		]);
		return await traces.list();
	}
	if (scenario === "write-failure") {
		await Bun.write(path.join(state.stateDir, "model-traces"), "directory blocked by a regular file");
		await command("/trace on");
		await session.prompt("TRACE_DISK_FAILURE");
		await traces.flush();
		const warning = traces.warning;
		await fs.unlink(path.join(state.stateDir, "model-traces"));
		await session.prompt("TRACE_DISK_RECOVERED");
		return { warning, records: await traces.list() };
	}
	throw new Error(`Unknown trace scenario: ${scenario}`);
}
