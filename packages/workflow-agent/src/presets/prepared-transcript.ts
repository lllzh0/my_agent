import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as path from "node:path";

/** Keep SDK startup metadata/exit entries off an existing transcript until activation. */
export class PreparedTranscript {
	readonly #files = new FileSessionStorage();
	readonly #memory = new MemorySessionStorage();
	readonly #path: string;
	readonly #size: number;
	#active = false;
	readonly storage: SessionStorage;
	constructor(file: string, bytes: Uint8Array) {
		this.#path = path.resolve(file);
		this.#size = bytes.byteLength;
		this.#memory.writeTextSync(this.#path, Buffer.from(bytes).toString("utf8"));
		const reads = new Set([
			"existsSync",
			"exists",
			"statSync",
			"readText",
			"readTextSync",
			"readTextSlices",
			"hasAssistantTurn",
		]);
		this.storage = new Proxy(this.#files, {
			get: (_target, key) => {
				if (key === "claimSession" || key === "withSessionFileLockSync") {
					const method = Reflect.get(this.#files, key);
					return typeof method === "function" ? method.bind(this.#files) : method;
				}
				const backend = this.#active ? this.#files : this.#memory;
				const method: unknown = Reflect.get(backend, key);
				if (typeof method !== "function") return method;
				return (...args: unknown[]) => {
					const current = this.#active ? this.#files : this.#memory;
					if (
						!this.#active &&
						typeof key === "string" &&
						reads.has(key) &&
						typeof args[0] === "string" &&
						!this.#memory.existsSync(args[0])
					) {
						return Reflect.apply(Reflect.get(this.#files, key), this.#files, args);
					}
					return Reflect.apply(Reflect.get(current, key), current, args);
				};
			},
		});
	}
	async activate(manager: SessionManager): Promise<void> {
		if (this.#active) return;
		const release = this.#files.claimSession(manager.getSessionId(), this.#path);
		if (!release) throw new Error("目标会话已被其他进程占用，未激活。");
		try {
			// close() is reusable and closes the cached memory append writer. The
			// extra file lease spans that close/reclaim so there is no ownership gap.
			await manager.flush();
			await manager.close();
			await this.#files.writeTextAtomic(this.#path, this.#memory.readTextSync(this.#path), {
				expectedSize: this.#size,
			});
			this.#active = true;
			manager.requireExclusiveWriter();
		} finally {
			release();
		}
	}
}
