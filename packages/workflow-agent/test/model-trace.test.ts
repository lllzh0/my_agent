import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fixture } from "./helpers";
import { compareTraceRequests, traceSnapshot } from "../src/diagnostics/trace-data";

test("trace comparison finds real message/tool changes while ignoring JSON object key order", () => {
	const left = traceSnapshot({ messages: [{ role: "user", content: "old" }], tools: [{ name: "read" }] });
	const right = traceSnapshot({ tools: [], messages: [{ content: "new", role: "user" }] });
	const diff = compareTraceRequests([left], [right]);
	expect(diff).toMatch(/^-\s+"content": "old"/m);
	expect(diff).toMatch(/^\+\s+"content": "new"/m);
	expect(diff).toContain('"name": "read"');
	expect(
		compareTraceRequests(
			[left],
			[traceSnapshot({ tools: [{ name: "read" }], messages: [{ content: "old", role: "user" }] })],
		),
	).toContain("已记录字段相同");
});

test("concurrent main and side requests keep their own payload and response", async () => {
	const f = await fixture();
	try {
		f.respond(body => ({
			text: JSON.stringify(body.messages).includes("TRACE_SIDE_CONCURRENT") ? "SIDE_RESPONSE" : "MAIN_RESPONSE",
			delayMs: 100,
		}));
		const run = await f.run({ action: "trace-concurrent" });
		expect(run.code, run.stderr).toBe(0);
		const records = run.result.actionResult as { source: string; requests: unknown; response: unknown }[];
		expect(records).toHaveLength(2);
		const main = records.find(record => record.source === "main")!;
		const side = records.find(record => record.source === "side")!;
		expect(JSON.stringify(main.response)).toContain("MAIN_RESPONSE");
		expect(JSON.stringify(main.requests)).not.toContain("TRACE_SIDE_CONCURRENT");
		expect(JSON.stringify(side.response)).toContain("SIDE_RESPONSE");
		expect(JSON.stringify(side.requests)).toContain("TRACE_SIDE_CONCURRENT");
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30000);

test("trace snapshots omit credentials, binary data, cycles and huge content without changing model input", () => {
	const body: Record<string, unknown> = {
		messages: [{ content: "sk-privatecredential" }],
		token: "private-opaque-credential",
		api_key: "private-key",
		headers: { Authorization: "private" },
		data: new Uint8Array([1, 2]),
		image: { type: "image", source: { type: "base64", media_type: "image/png", data: "BINARY_MEDIA_PAYLOAD" } },
		googleImage: { inlineData: { mimeType: "image/png", data: "BINARY_MEDIA_PAYLOAD" } },
		audio: { input_audio: { format: "wav", data: "BINARY_MEDIA_PAYLOAD" } },
		huge: "x".repeat(40000),
	};
	body.cycle = body;
	const snapshot = traceSnapshot(body);
	const serialized = JSON.stringify(snapshot);
	expect(serialized).not.toContain("private");
	expect(serialized).not.toContain("BINARY_MEDIA_PAYLOAD");
	expect(serialized).not.toContain("x".repeat(1000));
	expect(serialized.length).toBeLessThan(2000);
	expect(snapshot.truncated).toBe(true);
	expect(body.api_key).toBe("private-key");
	expect(compareTraceRequests([snapshot], [snapshot])).toContain("不能据此确认完整请求相同");
	expect(compareTraceRequests([], [])).toContain("没有捕获到");
});

test("trace switches and new sessions preserve separate request histories and compare changed tools", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "trace-lifecycle" });
		expect(run.code, run.stderr).toBe(0);
		const result = run.result.actionResult;
		expect(result.oldCount).toBe(2);
		expect(result.empty).toEqual([]);
		expect(result.newRecords).toHaveLength(1);
		expect(result.newRecords[0].sessionId).not.toBe(result.oldId);
		expect(JSON.stringify(result.newRecords)).toContain("TRACE_NEW_SESSION");
		expect(JSON.stringify(result.newRecords)).not.toContain("TRACE_FIRST");
		const oldNames = await fs.readdir(path.join(result.oldPath, "model-traces"));
		expect(oldNames.filter(name => name.endsWith(".json"))).toHaveLength(2);
		expect(run.result.displays.find((item: { title: string }) => item.title === "模型请求差异").text).toContain(
			'"name": "read"',
		);
		expect(f.requests).toHaveLength(4);
	} finally {
		await f.close();
	}
}, 30000);

test("a failed trace write cannot interrupt model output and subsequent writes can recover", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "trace-write-failure" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult.warning).toContain("写入失败");
		expect(run.result.actionResult.records).toHaveLength(1);
		expect(JSON.stringify(run.result.actionResult.records)).toContain("TRACE_DISK_RECOVERED");
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30000);

test("cancelling a stalled post-tool request records aborted output without marking it successful", async () => {
	const f = await fixture();
	try {
		f.callTool("find", { pattern: "*.ts" });
		f.stallAfterTool();
		const run = await f.run({ action: "trace-cancel" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult.map((entry: { status: string }) => entry.status)).toEqual(["toolUse", "aborted"]);
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30000);

test("trace is opt-in and human-owned; actual provider requests can be inspected without another model call", async () => {
	const f = await fixture();
	try {
		const disabled = await f.run({
			action: "commands",
			commands: ["/trace list"],
			promptAfterCommands: "UNRECORDED",
		});
		expect(disabled.code, disabled.stderr).toBe(0);
		expect(disabled.result.notifications.join(" ")).not.toContain("尚未接入");
		const denied = await f.run({
			action: "commands",
			inputSource: "extension",
			commands: ["/trace on"],
			promptAfterCommands: "STILL_UNRECORDED",
		});
		expect(denied.code, denied.stderr).toBe(0);
		const enabled = await f.run({ action: "commands", commands: ["/trace on"], promptAfterCommands: "TRACE_BODY" });
		expect(enabled.code, enabled.stderr).toBe(0);
		const sessionId = enabled.result.stateSessionId as string;
		const directory = path.join(f.home, "state", sessionId, "model-traces");
		const files = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
		expect(files).toHaveLength(1);
		const trace = await Bun.file(path.join(directory, files[0])).json();
		expect(trace.requests[0].body.messages).toEqual(f.requests.at(-1)!.messages);
		expect(trace.response.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "text", text: "LOCAL_PRODUCT_OK" })]),
		);
		expect(trace.status).toBe("stop");
		expect(JSON.stringify(trace)).not.toContain("fake-local-key");
		const count = f.requests.length;
		const inspect = await f.run({
			action: "commands",
			resume: enabled.result.sessionFile,
			commands: ["/trace list", `/trace show ${trace.id}`, `/trace compare ${trace.id} ${trace.id}`],
		});
		expect(inspect.code, inspect.stderr).toBe(0);
		expect(f.requests).toHaveLength(count);
		expect(inspect.result.displays.some((item: { text: string }) => item.text.includes("TRACE_BODY"))).toBe(true);
		for (const run of [disabled, denied]) {
			const dir = path.join(f.home, "state", run.result.stateSessionId, "model-traces");
			expect(await Bun.file(path.join(dir, "dummy")).exists()).toBe(false);
			expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
		}
	} finally {
		await f.close();
	}
}, 30000);

test("trace preserves tool call/result linkage and failed model requests", async () => {
	const f = await fixture();
	try {
		f.callTool("find", { pattern: "*.ts" });
		f.failAfterTools(1);
		const run = await f.run({ action: "commands", commands: ["/trace on"], promptAfterCommands: "TRACE_TOOLS" });
		expect(run.code, run.stderr).toBe(0);
		const directory = path.join(f.home, "state", run.result.stateSessionId, "model-traces");
		const files = (await fs.readdir(directory)).filter(name => name.endsWith(".json")).sort();
		const records = await Promise.all(files.map(name => Bun.file(path.join(directory, name)).json()));
		expect(records.map(record => record.status)).toEqual(["toolUse", "error"]);
		expect(records[0].response.content.find((part: { type: string }) => part.type === "toolCall").id).toBe(
			"call_product",
		);
		expect(
			records[1].requests[0].body.messages.find((message: { role: string }) => message.role === "tool").tool_call_id,
		).toBe("call_product");
		expect(records[1].response.errorMessage).toContain("401");
	} finally {
		await f.close();
	}
}, 30000);
