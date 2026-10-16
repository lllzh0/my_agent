import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { RawSseDebugSnapshot } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { atomicJson } from "../storage";
import { modelStreamSummary } from "./model-stream";

const advice = {
	configuration: "检查配置格式、所选资源与环境变量名；必要时使用 restore-config。",
	authentication: "检查所选服务的密钥是否有效，以及当前终端是否设置了对应环境变量。",
	permission: "检查计划模式、批准决定和允许的访问范围；不要改用其他工具绕过拒绝。",
	rate_limit: "服务限流或额度不足；检查额度和等待时间，结果未知的写入须先核实再重试。",
	network: "检查网络、代理和服务地址；恢复连接后先核实外部执行结果，再决定是否重试。",
	timeout: "请求超过等待时间；检查任务或服务状态，超时不代表外部操作没有执行。",
	cancelled: "操作已取消；保留已完成结果，继续前检查仍在运行的任务与外部状态。",
	parsing: "检查返回格式或资料是否受支持；正文提取失败时不能当作已读取来源。",
	unknown: "保留当前会话并检查本地工具或供应商日志；结果不确定的写入先核实再决定是否重试。",
};
export type ErrorCategory = keyof typeof advice;
export type ErrorOrigin = "model" | "tool" | "runtime";
/** Preserve a known model failure when the CLI forwards it to its common handler. */
export class ModelRequestError extends Error {}
export interface DiagnosticEvent {
	at: string;
	origin: ErrorOrigin;
	category: ErrorCategory;
	hint: string;
	httpStatus?: number;
}

function errorText(error: unknown): string {
	if (typeof error === "string") return error.slice(0, 8192);
	if (!error || typeof error !== "object") return "";
	const item = error as Record<string, unknown>;
	for (const key of ["message", "errorMessage"]) if (typeof item[key] === "string") return item[key].slice(0, 8192);
	if (Array.isArray(item.content))
		return item.content
			.slice(0, 4)
			.map(part => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
			.join("\n")
			.slice(0, 8192);
	return "";
}

export function classifyError(error: unknown, origin?: ErrorOrigin): Omit<DiagnosticEvent, "at" | "origin"> {
	if (error instanceof ModelRequestError) origin = "model";
	const text = errorText(error);
	const item = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
	const diagnosticText = [item.name, item.code, text].filter(value => typeof value === "string").join(" ");
	const rawStatus =
		item.status ??
		item.statusCode ??
		/\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:status[:\s]*)?([45]\d\d)\b/i.exec(text)?.[1] ??
		(origin === "model" ? /^\s*([45]\d\d)(?=[:\s])/.exec(text)?.[1] : undefined);
	const status = Number(rawStatus);
	const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
	let category: ErrorCategory = "unknown";
	if (httpStatus === 429 || /限流|rate.?limit|quota.*exceed/i.test(diagnosticText)) category = "rate_limit";
	else if (httpStatus === 401 || /unauthori[sz]ed|invalid.*(?:api.?key|credential)/i.test(diagnosticText))
		category = "authentication";
	else if (
		httpStatus === 403 ||
		/被拒绝|计划模式|受保护|超出.*范围|permission denied|EACCES|EPERM/i.test(diagnosticText)
	)
		category = "permission";
	else if (/timeout|timed.?out|\bstream stalled\b|超时|超过.*上限/i.test(diagnosticText)) category = "timeout";
	else if (/abort|cancel|取消|interrupted/i.test(diagnosticText)) category = "cancelled";
	else if (/配置|config\.json|resources\./i.test(diagnosticText)) category = "configuration";
	else if (/SyntaxError|JSON|parse|解析|格式不支持|无法提取|没有可提取/i.test(diagnosticText)) category = "parsing";
	else if (
		(httpStatus !== undefined && httpStatus >= 500) ||
		/ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|连接|断网|网络/i.test(diagnosticText)
	)
		category = "network";
	return { category, hint: advice[category], ...(httpStatus ? { httpStatus } : {}) };
}

function safeEvent(value: unknown): DiagnosticEvent | undefined {
	if (!value || typeof value !== "object") return;
	const entry = value as Record<string, unknown>;
	if (
		typeof entry.at !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.at) ||
		Number.isNaN(Date.parse(entry.at))
	)
		return;
	if (!["model", "tool", "runtime"].includes(String(entry.origin)) || !Object.hasOwn(advice, String(entry.category)))
		return;
	const category = entry.category as ErrorCategory;
	return {
		at: entry.at,
		origin: entry.origin as ErrorOrigin,
		category,
		hint: advice[category],
		...(typeof entry.httpStatus === "number" &&
		Number.isInteger(entry.httpStatus) &&
		entry.httpStatus >= 400 &&
		entry.httpStatus <= 599
			? { httpStatus: entry.httpStatus }
			: {}),
	};
}

async function readEvents(file: string): Promise<DiagnosticEvent[]> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > 256_000) return [];
		const value: unknown = await Bun.file(file).json();
		if (!Array.isArray(value)) return [];
		return value
			.slice(-200)
			.map(safeEvent)
			.filter((entry): entry is DiagnosticEvent => entry !== undefined);
	} catch {
		return [];
	}
}

export class Diagnostics {
	#events: DiagnosticEvent[] = [];
	#pending = Promise.resolve();
	writeFailed = false;
	constructor(readonly stateDir: string) {}
	async load(): Promise<void> {
		this.#events = await readEvents(path.join(this.stateDir, "errors.json"));
	}
	record(origin: ErrorOrigin, error: unknown): void {
		this.#events.push({ at: new Date().toISOString(), origin, ...classifyError(error, origin) });
		this.#events = this.#events.slice(-200);
		const snapshot = this.#events.slice();
		this.#pending = this.#pending
			.then(() => atomicJson(path.join(this.stateDir, "errors.json"), snapshot))
			.catch(() => {
				this.writeFailed = true;
			});
	}
	async flush(): Promise<void> {
		await this.#pending;
	}
	recordModelStream(message: AssistantMessage, snapshot: RawSseDebugSnapshot): void {
		const summary = modelStreamSummary(message, snapshot);
		this.#pending = this.#pending
			.then(() => atomicJson(path.join(this.stateDir, "model-stream.json"), summary))
			.catch(() => {
				this.writeFailed = true;
			});
	}
}

export async function recentDiagnostics(home: string): Promise<DiagnosticEvent[]> {
	try {
		const state = path.join(home, "state");
		const entries = await fs.readdir(state, { withFileTypes: true });
		const files = await Promise.all(
			entries
				.filter(entry => entry.isDirectory())
				.map(async entry => {
					const file = path.join(state, entry.name, "errors.json");
					const stat = await fs.lstat(file).catch(() => undefined);
					return stat?.isFile() ? { file, at: stat.mtimeMs } : undefined;
				}),
		);
		const selected = files
			.filter((entry): entry is { file: string; at: number } => entry !== undefined)
			.sort((a, b) => b.at - a.at)
			.slice(0, 20);
		const events = (await Promise.all(selected.map(entry => readEvents(entry.file)))).flat();
		return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
	} catch {
		return [];
	}
}
