import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { RawSseDebugSnapshot } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chars(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
}

/** Summarize the retained wire window; never persist raw frames, headers or generated text. */
export function modelStreamSummary(message: AssistantMessage, snapshot: RawSseDebugSnapshot, endedAt = Date.now()) {
	const http = { responses: 0, lastStatus: undefined as number | undefined };
	const wire = {
		frames: 0,
		frameChars: 0,
		jsonFrames: 0,
		emptyFrames: 0,
		unrecognizedJsonFrames: 0,
		malformedFrames: 0,
		truncatedFrames: 0,
		contentChars: 0,
		reasoningContentChars: 0,
		reasoningChars: 0,
		reasoningTextChars: 0,
		toolCallFragments: 0,
		finishFrames: 0,
		usageFrames: 0,
		serverErrorFrames: 0,
		doneSentinels: 0,
	};
	let firstEventAt: number | undefined;
	let lastEventAt: number | undefined;
	for (const record of snapshot.records) {
		if (
			record.timestamp < message.timestamp ||
			record.provider !== message.provider ||
			record.model !== message.model
		)
			continue;
		if (record.kind === "response") {
			http.responses++;
			http.lastStatus = record.status;
			continue;
		}
		firstEventAt ??= record.timestamp;
		lastEventAt = record.timestamp;
		wire.frames++;
		wire.frameChars += record.originalChars;
		if (record.truncated) wire.truncatedFrames++;
		const data = record.raw
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data === "[DONE]") {
			wire.doneSentinels++;
			continue;
		}
		if (!data) {
			wire.emptyFrames++;
			continue;
		}
		let frame: Record<string, unknown>;
		try {
			frame = object(JSON.parse(data));
		} catch {
			wire.malformedFrames++;
			continue;
		}
		wire.jsonFrames++;
		if (frame.usage) wire.usageFrames++;
		if (frame.error) wire.serverErrorFrames++;
		if (!Array.isArray(frame.choices) && !frame.usage && !frame.error) wire.unrecognizedJsonFrames++;
		const choice = object(Array.isArray(frame.choices) ? frame.choices[0] : undefined);
		if (choice.finish_reason) wire.finishFrames++;
		const delta = object(choice.delta);
		wire.contentChars += chars(delta.content);
		wire.reasoningContentChars += chars(delta.reasoning_content);
		wire.reasoningChars += chars(delta.reasoning);
		wire.reasoningTextChars += chars(delta.reasoning_text);
		if (Array.isArray(delta.tool_calls)) wire.toolCallFragments += delta.tool_calls.length;
	}
	const consumed = { textChars: 0, thinkingChars: 0, toolCalls: 0 };
	for (const block of message.content) {
		if (block.type === "text") consumed.textChars += block.text.length;
		if (block.type === "thinking") consumed.thinkingChars += block.thinking.length;
		if (block.type === "toolCall") consumed.toolCalls++;
	}
	return {
		schemaVersion: 1,
		startedAt: new Date(message.timestamp).toISOString(),
		endedAt: new Date(endedAt).toISOString(),
		stopReason: message.stopReason,
		http,
		wire,
		consumed,
		firstCompleteEventAt: firstEventAt === undefined ? undefined : new Date(firstEventAt).toISOString(),
		lastCompleteEventAt: lastEventAt === undefined ? undefined : new Date(lastEventAt).toISOString(),
		sinceLastCompleteEventMs: lastEventAt === undefined ? undefined : Math.max(0, endedAt - lastEventAt),
		bufferDroppedRecords: snapshot.droppedRecords,
		note: "仅统计保留的完整 SSE 事件；缓冲区淘汰、事件截断或尚未形成完整事件的数据不在完整统计范围内。没有事件不能单独区分服务端与网络故障。",
	};
}
