import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelTraces } from "../src/diagnostics/model-trace";

// Exercise the public stream decorator with a provider that rebuilds its request.
// Host tests separately verify real HTTP payloads and streamed model responses.
test("deep request records stay within the on-disk limit and remain inspectable", async () => {
	using directory = TempDir.createSync("my-agent-trace-size-");
	const traces = new ModelTraces(() => ({ sessionId: "size", stateDir: directory.path() }));
	const model = getBundledModel("openai", "gpt-4o-mini")!;
	let payload: unknown = Array(3500).fill(null);
	for (let i = 0; i < 20; i++) payload = { nested: payload };
	const stream = traces.decorate(async (requestModel, _context, options) => {
		await options?.onPayload?.(payload, requestModel);
		await options?.onPayload?.(payload, requestModel);
		const output = createAssistantMessageEventStream();
		output.end();
		return output;
	}, "main");
	traces.setEnabled(true);
	await (await stream(model, { messages: [] })).result().catch(() => {});
	await traces.close();
	const records = await traces.list();
	expect(records).toHaveLength(1);
	expect(records[0].truncated).toBe(true);
	expect(records[0].requests.every(request => request.truncated)).toBe(true);
	const file = path.join(directory.path(), "model-traces", `${records[0].id}.json`);
	expect((await fs.stat(file)).size).toBeLessThanOrEqual(256 * 1024);
});

test("trace retention prunes only owned records and restarts with recording disabled", async () => {
	using directory = TempDir.createSync("my-agent-trace-retention-");
	const current = () => ({ sessionId: "retention", stateDir: directory.path() });
	const traces = new ModelTraces(current);
	const model = getBundledModel("openai", "gpt-4o-mini")!;
	const stream = traces.decorate(async (requestModel, _context, options) => {
		await options?.onPayload?.({ messages: ["retention request"] }, requestModel);
		const output = createAssistantMessageEventStream();
		output.end();
		return output;
	}, "main");
	traces.setEnabled(true);
	const sentinel = path.join(directory.path(), "model-traces", "unrelated.txt");
	await Bun.write(sentinel, "KEEP");
	for (let i = 0; i < 103; i++) {
		await (await stream(model, { messages: [] })).result().catch(() => {});
		await traces.flush();
	}
	await traces.close();
	const reopened = new ModelTraces(current);
	expect(reopened.enabled).toBe(false);
	expect(await reopened.list()).toHaveLength(100);
	expect(await Bun.file(sentinel).text()).toBe("KEEP");
	await reopened.close();
});
