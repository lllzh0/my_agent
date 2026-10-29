import { presetId } from "./presets";

export interface PresetTarget {
	preset: string;
	resume?: string;
	light?: boolean;
	plan?: boolean;
}
export interface HandoffSession extends PresetTarget {
	id: string;
	resume: string;
}
export interface HandoffMessage {
	version: 1;
	token: string;
	type: "online" | "request" | "cancel" | "allocated" | "prepared" | "activate" | "close" | "closed" | "failed";
	requestId?: string;
	target?: PresetTarget;
	session?: HandoffSession;
	error?: string;
}

/** Referenced timer also advances Bun/Windows when IPC is otherwise completely idle. */
export function handoffDeadline(ms: number, signals: AbortSignal[] = []): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("预设交接等待超时。")), ms);
	return { signal: AbortSignal.any([controller.signal, ...signals]), dispose: () => clearTimeout(timer) };
}

export function handoffMessage(input: unknown, token: string): HandoffMessage | undefined {
	if (!input || typeof input !== "object") return;
	const value = input as Record<string, unknown>;
	if (value.version !== 1 || value.token !== token || typeof value.type !== "string") return;
	if (
		!["online", "request", "cancel", "allocated", "prepared", "activate", "close", "closed", "failed"].includes(
			value.type,
		)
	)
		return;
	if (
		value.requestId !== undefined &&
		(typeof value.requestId !== "string" || !/^[\da-f-]{36}$/i.test(value.requestId))
	)
		return;
	for (const key of ["target", "session"]) {
		if (value[key] === undefined) continue;
		if (!value[key] || typeof value[key] !== "object") return;
		const target = value[key] as Record<string, unknown>;
		try {
			if (typeof target.preset !== "string") return;
			presetId(target.preset);
		} catch {
			return;
		}
		if (Object.keys(target).some(name => !["preset", "resume", "light", "plan", "id"].includes(name))) return;
		if (target.resume !== undefined && (typeof target.resume !== "string" || target.resume.includes("\0"))) return;
		if (
			target.light !== undefined &&
			(typeof target.light !== "boolean" || (target.light && target.preset !== "legacy"))
		)
			return;
		if (target.plan !== undefined && typeof target.plan !== "boolean") return;
		if (
			key === "session" &&
			(typeof target.id !== "string" || !/^[\da-f-]{36}$/i.test(target.id) || typeof target.resume !== "string")
		)
			return;
	}
	if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 2000)) return;
	return value as unknown as HandoffMessage;
}

/** One owner per inbox; abort removes the waiter instead of stealing a later message. */
export class HandoffInbox {
	#queue: HandoffMessage[] = [];
	#wake?: () => void;
	#error?: Error;
	put(message: HandoffMessage): void {
		this.#queue.push(message);
		this.#wake?.();
	}
	close(error: Error): void {
		this.#error = error;
		this.#wake?.();
	}
	async next(signal: AbortSignal): Promise<HandoffMessage> {
		for (;;) {
			signal.throwIfAborted();
			const message = this.#queue.shift();
			if (message) return message;
			if (this.#error) throw this.#error;
			const pending = Promise.withResolvers<void>();
			this.#wake = () => pending.resolve();
			const abort = () => pending.reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			try {
				await pending.promise;
			} finally {
				signal.removeEventListener("abort", abort);
				this.#wake = undefined;
			}
		}
	}
}
