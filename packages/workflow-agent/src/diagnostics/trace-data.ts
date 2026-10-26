import { createTwoFilesPatch } from "diff";
import { redact } from "../storage";

export interface TraceSnapshot {
	body: unknown;
	truncated: boolean;
}

/** A bounded copy of diagnostic data; never mutate the actual provider payload. */
export function traceSnapshot(input: unknown): TraceSnapshot {
	let remaining = 48_000;
	let nodes = 4000;
	let truncated = false;
	const seen = new Set<object>();
	const omit = (reason: string) => {
		truncated = true;
		return `[省略：${reason}]`;
	};
	const visit = (value: unknown, depth: number): unknown => {
		if (--nodes < 0 || remaining <= 0 || depth > 24) return omit("达到记录上限");
		if (typeof value === "string") {
			if (value.length > 32_000 || value.length > remaining) return omit(`长文本 ${value.length} 字符`);
			remaining -= value.length;
			if (/^data:[^,]+;base64,/i.test(value)) return omit("内嵌媒体");
			return redact(value);
		}
		if (value === null || typeof value === "boolean" || typeof value === "number") return value;
		if (!value || typeof value !== "object") return String(value);
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return omit("二进制数据");
		const object = value as Record<string, unknown>;
		if (
			(typeof object.type === "string" &&
				/^(?:image|input_image|output_image|image_url|input_audio|audio|video|base64)$/.test(object.type)) ||
			("data" in object &&
				[object.mimeType, object.mime_type, object.media_type].some(type => typeof type === "string"))
		)
			return omit("媒体内容");
		if (seen.has(value)) return omit("循环引用");
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				const result: unknown[] = [];
				for (const item of value) {
					if (nodes <= 0 || remaining <= 0) {
						result.push(omit("剩余数组项"));
						break;
					}
					result.push(visit(item, depth + 1));
				}
				return result;
			}
			const result: Record<string, unknown> = Object.create(null);
			for (const key of Object.keys(value)) {
				if (nodes <= 0 || remaining <= 0 || key.length > 1000) {
					result.__trace_omitted__ = omit("剩余对象字段");
					break;
				}
				remaining -= key.length;
				if (/^(?:inline_?data|input_?audio|b64_json|file_data)$/i.test(key)) {
					result[key] = omit("内嵌媒体");
					continue;
				}
				if (
					/^(?:headers?|authorization|cookies?|api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|credentials?|signature|encrypted_content)$/i.test(
						key,
					)
				) {
					result[key] = "[REDACTED]";
					continue;
				}
				const field = (value as Record<string, unknown>)[key];
				if (field !== undefined) result[key] = visit(field, depth + 1);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	};
	try {
		const body = visit(input, 0);
		if (Buffer.byteLength(JSON.stringify(body)) > 96 * 1024)
			return { body: omit("序列化超过 96 KiB"), truncated: true };
		return { body, truncated };
	} catch {
		return { body: "[省略：无法读取诊断对象]", truncated: true };
	}
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, sorted(entry)]),
		);
	return value;
}

/** Compare only retained provider request snapshots, never synthesized history. */
export function compareTraceRequests(left: TraceSnapshot[], right: TraceSnapshot[]): string {
	const note =
		!left.length || !right.length
			? "一侧没有捕获到供应商请求正文，无法完整比较。\n"
			: [...left, ...right].some(item => item.truncated)
				? "存在省略内容；差异仅覆盖已保留字段，不能据此确认完整请求相同。\n"
				: "差异针对已记录的请求字段；认证头、敏感字段与媒体内容不参与完整性判断。\n";
	const a = `${JSON.stringify(sorted(left.map(item => item.body)), null, 2)}\n`;
	const b = `${JSON.stringify(sorted(right.map(item => item.body)), null, 2)}\n`;
	if (a === b) return `${note}已记录字段相同。`;
	const patch = createTwoFilesPatch("request-A", "request-B", a, b, undefined, undefined, {
		context: 3,
		timeout: 1000,
	});
	return note + (patch ?? "差异计算达到时间上限，请分别查看两次请求。");
}
