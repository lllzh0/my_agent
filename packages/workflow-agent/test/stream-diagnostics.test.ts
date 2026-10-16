import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { RawSseDebugRecord, RawSseDebugSnapshot } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { modelStreamSummary } from "../src/diagnostics/model-stream";
import { fixture } from "./helpers";

function failedMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		timestamp: 1000,
		stopReason: "aborted",
		content: [{ type: "thinking", thinking: "..." }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function wireEvent(sequence: number, timestamp: number, data: string): RawSseDebugRecord {
	return {
		kind: "event",
		sequence,
		timestamp,
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		api: "openai-completions",
		event: null,
		raw: [`data: ${data}`, ""],
		truncated: false,
		originalChars: data.length + 7,
	};
}

test("stream diagnostics distinguish received answer data from consumed output and omit arbitrary frame contents", () => {
	const records: RawSseDebugRecord[] = [
		wireEvent(1, 900, "[DONE]"),
		wireEvent(
			2,
			1100,
			JSON.stringify({
				choices: [{ delta: { content: "PRIVATE_ANSWER", reasoning_content: "PRIVATE_THOUGHT" } }],
				private_token: "PRIVATE_SECRET",
			}),
		),
		wireEvent(3, 1200, "PRIVATE_MALFORMED"),
		wireEvent(4, 1300, JSON.stringify({ PRIVATE_FIELD: "PRIVATE_PAYLOAD" })),
		wireEvent(5, 1400, JSON.stringify({ choices: [{ delta: {}, finish_reason: "PRIVATE_FINISH_REASON" }] })),
		wireEvent(6, 1500, "[DONE]"),
	];
	const snapshot: RawSseDebugSnapshot = { records, totalEvents: records.length, droppedRecords: 2, droppedChars: 200 };
	const report = modelStreamSummary(failedMessage(), snapshot, 2000);
	expect(report.wire).toMatchObject({
		jsonFrames: 3,
		contentChars: 14,
		reasoningContentChars: 15,
		malformedFrames: 1,
		unrecognizedJsonFrames: 1,
		finishFrames: 1,
		doneSentinels: 1,
	});
	expect(report.consumed).toEqual({ thinkingChars: 3, textChars: 0, toolCalls: 0 });
	expect(report.sinceLastCompleteEventMs).toBe(500);
	expect(report.bufferDroppedRecords).toBe(2);
	expect(JSON.stringify(report)).not.toContain("PRIVATE_");
});

test("a failure before response headers does not reuse evidence from a previous request", () => {
	const snapshot: RawSseDebugSnapshot = {
		records: [
			{
				kind: "response",
				sequence: 1,
				timestamp: 800,
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				status: 200,
				requestId: "PRIVATE_OLD_REQUEST",
			},
			wireEvent(2, 900, "[DONE]"),
		],
		totalEvents: 1,
		droppedRecords: 0,
		droppedChars: 0,
	};
	const report = modelStreamSummary(failedMessage(), snapshot, 2000);
	expect(report.http.responses).toBe(0);
	expect(report.wire.frames).toBe(0);
	expect(report.sinceLastCompleteEventMs).toBeUndefined();
	expect(JSON.stringify(report)).not.toContain("PRIVATE_");
});

test("cancelling a stalled post-tool response preserves wire and consumed counts without private contents", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "probe.txt"), "LIVE_TOOL_OK");
		f.callTool("read", { path: "probe.txt" });
		f.stallAfterTool();
		const run = await f.run({ action: "abort-stalled-model" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		const id = (await fs.readdir(path.join(f.home, "state")))[0];
		const text = await Bun.file(path.join(f.home, "state", id, "model-stream.json")).text();
		const report = JSON.parse(text);
		expect(report).toMatchObject({
			schemaVersion: 1,
			stopReason: "aborted",
			http: { responses: 1, lastStatus: 200 },
			wire: { jsonFrames: 1, reasoningContentChars: 3, contentChars: 0, finishFrames: 0, doneSentinels: 0 },
			consumed: { thinkingChars: 3, textChars: 0, toolCalls: 0 },
		});
		expect(report.sinceLastCompleteEventMs).toBeGreaterThanOrEqual(0);
		for (const privateValue of ["PRIVATE_STREAM_DETAIL", "LIVE_TOOL_OK", "PRODUCT_HISTORY", "fake-local-key", f.cwd])
			expect(text).not.toContain(privateValue);
	} finally {
		await f.close();
	}
}, 30000);
