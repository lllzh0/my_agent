import type { Host } from "../runtime/host";
import { saveSessionSnapshot } from "../runtime/session-snapshot";
import {
	HandoffInbox,
	handoffDeadline,
	handoffMessage,
	type HandoffMessage,
	type HandoffSession,
	type PresetTarget,
} from "./handoff-protocol";

export interface PresetHandoff {
	busy: boolean;
	switch(target: PresetTarget, signal?: AbortSignal): Promise<void>;
}

/** This channel exists only for the launcher-owned child, never model text/stdout. */
export class HandoffConnection implements PresetHandoff {
	readonly #token: string;
	readonly #inbox = new HandoffInbox();
	readonly #lifetime = new AbortController();
	#host?: Host;
	#freeze?: (cancel: () => void) => () => void;
	#close?: () => void;
	#requestId?: string;
	committed = false;
	busy = false;
	constructor(token: string) {
		this.#token = token;
		process.on("message", this.#receive);
		process.once("SIGTERM", this.#abort);
	}
	#receive = (value: unknown) => {
		const message = handoffMessage(value, this.#token);
		if (message) this.#inbox.put(message);
	};
	#abort = () => this.#lifetime.abort(new Error("预设进程已取消。"));
	send(message: Omit<HandoffMessage, "version" | "token">): void {
		process.send?.({ ...message, version: 1, token: this.#token });
	}
	session(host: Host): HandoffSession {
		return {
			id: host.state.sessionId,
			preset: host.state.preset?.id ?? "legacy",
			resume: host.session.sessionFile!,
			light: !host.state.preset && host.state.light,
			plan: host.state.policy.mode === "plan",
		};
	}
	async prepare(host: Host): Promise<void> {
		this.send({ type: "prepared", session: this.session(host) });
		const deadline = handoffDeadline(180_000, [this.#lifetime.signal]);
		try {
			for (;;) {
				if ((await this.#inbox.next(deadline.signal)).type === "activate") return;
			}
		} finally {
			deadline.dispose();
		}
	}
	attach(host: Host, freeze: (cancel: () => void) => () => void, close: () => void): void {
		this.#host = host;
		this.#freeze = freeze;
		this.#close = close;
		host.state.handoff = this;
		this.send({ type: "online", session: this.session(host) });
	}
	async switch(target: PresetTarget, signal?: AbortSignal): Promise<void> {
		if (this.busy || !this.#host || !this.#freeze) throw new Error("预设交接尚未就绪或正在进行。");
		const host = this.#host;
		host.state.sessions!.assertIdle();
		this.busy = true;
		this.#requestId = Bun.randomUUIDv7();
		const id = this.#requestId;
		let cancelled = false;
		const release = this.#freeze(() => {
			cancelled = true;
			this.send({ type: "cancel", requestId: id });
		});
		const deadline = handoffDeadline(200_000, [this.#lifetime.signal, ...(signal ? [signal] : [])]);
		try {
			await saveSessionSnapshot(host.state, host.session);
			if (cancelled) throw new Error("交接已取消，原会话保留。");
			this.send({ type: "request", requestId: id, target, session: this.session(host) });
			for (;;) {
				const message = await this.#inbox.next(deadline.signal);
				if (message.requestId !== id) continue;
				if (message.type === "failed") throw new Error(message.error ?? "预设准备失败，原会话保留。");
				if (message.type === "close") {
					host.state.sessions!.assertIdle();
					this.committed = true;
					this.#close?.();
					return;
				}
			}
		} finally {
			deadline.dispose();
			if (!this.committed) {
				this.send({ type: "cancel", requestId: id });
				release();
				this.busy = false;
				this.#requestId = undefined;
			}
		}
	}
	finish(error?: unknown): void {
		if (this.committed || error)
			this.send(
				error
					? { type: "failed", requestId: this.#requestId, error: String(error).slice(0, 1900) }
					: { type: "closed", requestId: this.#requestId },
			);
		process.removeListener("message", this.#receive);
		process.removeListener("SIGTERM", this.#abort);
		process.disconnect?.();
	}
}
