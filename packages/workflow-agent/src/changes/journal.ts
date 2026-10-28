import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import { atomicJson } from "../storage.ts";
import { contained, canonicalPath } from "../policy/policy.ts";
import { JournalStore, type JournalStats } from "./store.ts";

export interface Change {
	id: string;
	turn: string;
	path: string;
	before: string | null;
	after: string | null;
	mode: number;
	at: string;
	restored: boolean;
}

/** Receives a canonical absolute path. Throw to reject the current operation. */
export type JournalPathValidator = (canonicalPath: string) => void | Promise<void>;

export class ChangeJournal {
	readonly home: string;
	readonly workspace: string;
	#validatePath?: JournalPathValidator;
	#store?: JournalStore;
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;
	#closing?: Promise<void>;

	constructor(home: string, workspace: string, validatePath?: JournalPathValidator) {
		this.home = home;
		this.workspace = workspace;
		this.#validatePath = validatePath;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("修改记录已经关闭");
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		this.#assertOpen();
		const run = this.#queue.then(operation);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #ready(): Promise<JournalStore> {
		this.#store ??= await JournalStore.open(this.home);
		return this.#store;
	}

	async load(): Promise<void> {
		await this.#enqueue(async () => {
			await this.#ready();
		});
	}

	list(): Change[] {
		this.#assertOpen();
		return this.#store?.list() ?? [];
	}

	get(id: string): Change | undefined {
		this.#assertOpen();
		return this.#store?.find(id);
	}

	latestTurn(): Change[] {
		this.#assertOpen();
		return this.#store?.latestTurn() ?? [];
	}

	diff(id: string): string {
		this.#assertOpen();
		const change = this.#store?.find(id);
		if (!change) throw new Error("修改记录不存在");
		return createTwoFilesPatch(change.path, change.path, change.before ?? "", change.after ?? "", "before", "after");
	}

	async stats(): Promise<JournalStats> {
		return this.#enqueue(async () => (await this.#ready()).stats());
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = this.#queue.then(() => {
			this.#store?.close();
			this.#store = undefined;
		});
		this.#queue = this.#closing.catch(() => undefined);
		return this.#closing;
	}

	async #validatedPath(target: string, restoring = false): Promise<string> {
		const canonical = await canonicalPath(target);
		if (restoring && canonical !== target) throw new Error("恢复路径发生变化");
		if (this.#validatePath) await this.#validatePath(canonical);
		else if (!contained(await canonicalPath(this.workspace), canonical))
			throw new Error(restoring ? "恢复路径超出工作区" : "修改记录仅覆盖工作区");
		return canonical;
	}

	async #text(target: string): Promise<string | null> {
		try {
			const stat = await fs.lstat(target);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1_000_000)
				throw new Error("恢复只支持 1MB 以下的普通文本文件");
			const bytes = await fs.readFile(target);
			if (bytes.includes(0)) throw new Error("二进制文件不进入文本修改记录");
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async capture<T>(turn: string, target: string, operation: () => Promise<T>): Promise<T> {
		return this.#enqueue(async () => {
			const store = await this.#ready();
			const canonical = await this.#validatedPath(target);
			const before = await this.#text(canonical);
			const mode = before === null ? 0o644 : (await fs.lstat(canonical)).mode & 0o777;
			try {
				return await operation();
			} finally {
				const after = await this.#text(canonical);
				if (before !== after)
					store.append({
						id: crypto.randomUUID(),
						turn,
						path: canonical,
						before,
						after,
						mode,
						at: new Date().toISOString(),
						restored: false,
					});
			}
		});
	}

	/** Reuse the same text/path limits for approval and final write validation. */
	async inspect(target: string): Promise<string | null> {
		this.#assertOpen();
		return this.#text(await this.#validatedPath(target));
	}

	async restore(id: string): Promise<void> {
		await this.restoreMany([id]);
	}

	async restoreMany(
		ids: string[],
		validation?: { prepare: () => Promise<void>; beforeWrite: () => void },
	): Promise<void> {
		const requested = [...ids];
		await this.#enqueue(async () => {
			const store = await this.#ready();
			await validation?.prepare();
			if (!requested.length || new Set(requested).size !== requested.length)
				throw new Error("没有可恢复的完整修改记录");
			const selected = store.select(requested);
			if (selected.length !== requested.length) throw new Error("没有可恢复的完整修改记录");
			const groups = new Map<string, Change[]>();
			for (const change of selected) {
				const items = groups.get(change.path) ?? [];
				items.push(change);
				groups.set(change.path, items);
			}
			for (const [target, changes] of groups) {
				await this.#validatedPath(target, true);
				if ((await this.#text(target)) !== changes.at(-1)!.after)
					throw new Error(`恢复冲突：${target} 已有新的修改，拒绝覆盖`);
				for (let index = 1; index < changes.length; index++)
					if (changes[index].before !== changes[index - 1].after)
						throw new Error("恢复冲突：选中的修改之间存在未包含的文件变更");
			}
			await atomicJson(path.join(this.home, "restore-backup.json"), selected);
			const restored: string[] = [];
			try {
				for (const [target, changes] of groups) {
					await validation?.prepare();
					await this.#validatedPath(target, true);
					const before = changes[0].before;
					if ((await this.#text(target)) !== changes.at(-1)!.after)
						throw new Error(`恢复冲突：预览后 ${target} 发生变化`);
					validation?.beforeWrite();
					if (before === null) await fs.unlink(target);
					else {
						await Bun.write(target, before);
						await fs.chmod(target, changes[0].mode);
					}
					restored.push(target);
					store.markRestored(changes.map(change => change.id));
				}
			} catch (error) {
				throw new Error(
					`${String(error)}；已恢复：${restored.join(", ") || "无"}；其他文件未继续处理，临时备份保留在 ${this.home}`,
				);
			}
		});
	}
}
