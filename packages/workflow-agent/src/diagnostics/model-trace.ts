import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelStreamDecorator } from "@oh-my-pi/pi-coding-agent/sdk";
import { atomicJson } from "../storage";
import { traceSnapshot, type TraceSnapshot } from "./trace-data";

const MAX_RECORDS = 100;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_PENDING = 32;
const TRACE_FILE = /^[0-9a-f-]{36}\.json$/;

export interface ModelTraceRecord {
	version: 1;
	id: string;
	sessionId: string;
	source: "main" | "side";
	captureStage: "provider_payload_hook";
	model: { provider: string; id: string; api: string };
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	status: string;
	requests: TraceSnapshot[];
	httpStatuses: number[];
	response?: unknown;
	truncated: boolean;
	notes: string[];
}

interface PendingTrace {
	record: ModelTraceRecord;
	directory: string;
	epoch: number;
}

/** Local opt-in diagnostics. Writes never participate in model success/failure. */
export class ModelTraces {
	#current: () => { sessionId: string; stateDir: string };
	#enabled = false;
	#closed = false;
	#epoch = 0;
	#active = new Map<string, PendingTrace>();
	#updates = new Map<string, { directory: string; record: ModelTraceRecord }>();
	#writer?: Promise<void>;
	#warning?: string;
	constructor(current: () => { sessionId: string; stateDir: string }) {
		this.#current = current;
	}
	get enabled(): boolean {
		return this.#enabled;
	}
	get warning(): string | undefined {
		return this.#warning;
	}
	setEnabled(enabled: boolean): void {
		if (this.#closed) throw new Error("轨迹记录已关闭。");
		if (enabled === this.#enabled) return;
		this.#enabled = enabled;
		this.#epoch++;
		if (!enabled) {
			for (const pending of this.#active.values()) {
				pending.record.status = "recording_stopped";
				pending.record.notes.push("用户停止记录，后续响应未保存；这不是模型请求的结束状态。");
				this.#enqueue(pending);
			}
			this.#active.clear();
		}
	}
	#live(pending: PendingTrace): boolean {
		return this.#enabled && pending.epoch === this.#epoch && this.#active.has(pending.record.id);
	}
	decorate: ModelStreamDecorator = (stream, source) => async (model, context, options) => {
		if (!this.#enabled || this.#closed) return stream(model, context, options);
		if (this.#active.size >= MAX_PENDING) {
			this.#warning = "同时记录的请求达到 32 条上限，部分请求未记录。";
			return stream(model, context, options);
		}
		const current = this.#current();
		const record: ModelTraceRecord = {
			version: 1,
			id: Bun.randomUUIDv7(),
			sessionId: current.sessionId,
			source,
			captureStage: "provider_payload_hook",
			model: { provider: model.provider, id: model.id, api: model.api },
			startedAt: Date.now(),
			status: "running",
			requests: [],
			httpStatuses: [],
			truncated: false,
			notes: ["正文来自供应商发送前的 onPayload 接口；后续协议转换、传输重试和原始响应流不在记录范围内。"],
		};
		const pending: PendingTrace = {
			record,
			directory: path.join(current.stateDir, "model-traces"),
			epoch: this.#epoch,
		};
		this.#active.set(record.id, pending);
		this.#enqueue(pending);
		const finish = (message?: AssistantMessage, error?: unknown) => {
			if (!this.#live(pending)) return;
			const response = traceSnapshot(
				message
					? {
							content: message.content,
							usage: message.usage,
							stopReason: message.stopReason,
							errorMessage: message.errorMessage,
							duration: message.duration,
							ttft: message.ttft,
						}
					: { errorMessage: error instanceof Error ? error.message : String(error) },
			);
			record.response = response.body;
			record.truncated ||= response.truncated;
			record.status = message?.stopReason ?? (options?.signal?.aborted ? "aborted" : "error");
			record.endedAt = Date.now();
			record.durationMs = Math.max(0, record.endedAt - record.startedAt);
			if (!record.requests.length) record.notes.push("此调用没有经过请求正文捕获接口，未用聊天记录补造请求。");
			this.#active.delete(record.id);
			this.#enqueue(pending);
		};
		try {
			const result = await stream(model, context, {
				...options,
				onPayload: async (payload, requestModel, signal) => {
					const replacement = await options?.onPayload?.(payload, requestModel, signal);
					if (this.#live(pending)) {
						if (record.requests.length < 2) {
							const snapshot = traceSnapshot(replacement === undefined ? payload : replacement);
							record.requests.push(snapshot);
							record.truncated ||= snapshot.truncated;
						} else if (!record.notes.includes("请求正文重复构造超过 2 次，后续正文已省略。")) {
							record.truncated = true;
							record.notes.push("请求正文重复构造超过 2 次，后续正文已省略。");
						}
						this.#enqueue(pending);
					}
					return replacement;
				},
				onResponse: async (response, responseModel, signal) => {
					if (this.#live(pending) && record.httpStatuses.length < 16) record.httpStatuses.push(response.status);
					await options?.onResponse?.(response, responseModel, signal);
				},
			});
			// Observe the final value without consuming, buffering or replacing the event iterator.
			void result
				.result()
				.then(
					message => finish(message),
					error => finish(undefined, error),
				)
				.catch(() => {
					this.#active.delete(record.id);
					this.#warning = "无法整理一条模型轨迹，模型请求不受影响。";
				});
			return result;
		} catch (error) {
			finish(undefined, error);
			throw error;
		}
	};
	#enqueue(pending: PendingTrace): void {
		try {
			const file = path.join(pending.directory, `${pending.record.id}.json`);
			if (!this.#updates.has(file) && this.#updates.size >= MAX_PENDING) {
				this.#warning = "轨迹写入队列达到上限，部分更新未保存。";
				return;
			}
			const record = structuredClone(pending.record);
			// atomicJson writes indented JSON plus a newline. Compact JSON can be much
			// smaller for deep tool schemas and previously produced unreadable records.
			if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) > MAX_RECORD_BYTES) {
				record.requests = record.requests.map(() => ({ body: "[省略：整条记录超过 256 KiB]", truncated: true }));
				record.response = "[省略：整条记录超过 256 KiB]";
				record.truncated = true;
			}
			if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) > MAX_RECORD_BYTES) {
				this.#warning = "轨迹元数据超过 256 KiB，已跳过此条记录。";
				return;
			}
			this.#updates.set(file, { directory: pending.directory, record });
			this.#startWriter();
		} catch {
			this.#warning = "无法复制轨迹数据，模型请求不受影响。";
		}
	}
	#startWriter(): void {
		if (this.#writer) return;
		this.#writer = this.#drain().finally(() => {
			this.#writer = undefined;
			if (this.#updates.size) this.#startWriter();
		});
	}
	async #directory(directory: string, create = false): Promise<void> {
		if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const info = await fs.lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("轨迹目录必须是普通目录。");
	}
	async #drain(): Promise<void> {
		while (this.#updates.size) {
			const [file, update] = this.#updates.entries().next().value!;
			this.#updates.delete(file);
			try {
				await this.#directory(update.directory, true);
				await atomicJson(file, update.record);
				const names = (await fs.readdir(update.directory)).filter(name => TRACE_FILE.test(name)).sort();
				for (const name of names.slice(0, Math.max(0, names.length - MAX_RECORDS)))
					await fs.unlink(path.join(update.directory, name));
			} catch {
				this.#warning = "模型轨迹写入失败；部分记录可能缺失或仍显示进行中，模型请求不受影响。";
			}
		}
	}
	async flush(): Promise<void> {
		while (this.#writer) await this.#writer;
	}
	async close(): Promise<void> {
		this.setEnabled(false);
		this.#closed = true;
		await this.flush();
	}
	async list(): Promise<ModelTraceRecord[]> {
		await this.flush();
		const current = this.#current();
		const directory = path.join(current.stateDir, "model-traces");
		try {
			await this.#directory(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const names = (await fs.readdir(directory))
			.filter(name => TRACE_FILE.test(name))
			.sort()
			.slice(-MAX_RECORDS);
		const records: ModelTraceRecord[] = [];
		for (const name of names) {
			try {
				const file = path.join(directory, name);
				const info = await fs.lstat(file);
				if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("invalid trace file");
				const data: unknown = await Bun.file(file).json();
				if (!data || typeof data !== "object") throw new Error("invalid trace");
				const record = data as ModelTraceRecord;
				if (
					record.version !== 1 ||
					record.sessionId !== current.sessionId ||
					`${record.id}.json` !== name ||
					!Array.isArray(record.requests) ||
					record.requests.length > 2 ||
					!record.model ||
					typeof record.status !== "string"
				)
					throw new Error("invalid trace metadata");
				records.push(record);
			} catch {
				this.#warning = "部分轨迹文件损坏、过大或不可读，已跳过。";
			}
		}
		return records;
	}
	async get(id: string): Promise<ModelTraceRecord> {
		if (!/^[0-9a-f-]{4,36}$/.test(id)) throw new Error("使用 /trace list 中的轨迹 ID 或唯一前缀。");
		const matches = (await this.list()).filter(record => record.id.startsWith(id));
		if (matches.length !== 1)
			throw new Error(matches.length ? "轨迹 ID 前缀不唯一。" : "未找到轨迹，可能已达到保留上限或不属于当前会话。");
		return matches[0];
	}
}
