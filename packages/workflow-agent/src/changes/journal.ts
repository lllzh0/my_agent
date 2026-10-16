import * as fs from "node:fs/promises";
const { readFile, lstat, unlink, writeFile, chmod, mkdir } = fs;
import * as path from "node:path";
const { join, dirname } = path;
import { randomUUID } from "node:crypto";
import { atomicJson, readJson } from "../storage.ts";
import { contained, canonicalPath } from "../policy/policy.ts";
import { createTwoFilesPatch } from "diff";

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
export class ChangeJournal {
	readonly home: string;
	readonly workspace: string;
	#changes: Change[] = [];
	#queue: Promise<unknown> = Promise.resolve();
	constructor(home: string, workspace: string) {
		this.home = home;
		this.workspace = workspace;
	}
	async load(): Promise<void> {
		const value = await readJson(join(this.home, "changes.json"));
		if (Array.isArray(value)) this.#changes = value as Change[];
	}
	list(): Change[] {
		return this.#changes.map(x => ({ ...x }));
	}
	diff(id: string): string {
		const x = this.#changes.find(x => x.id === id);
		if (!x) throw new Error("修改记录不存在");
		return createTwoFilesPatch(x.path, x.path, x.before ?? "", x.after ?? "", "before", "after");
	}
	async #text(path: string): Promise<string | null> {
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1_000_000)
				throw new Error("恢复只支持 1MB 以下的普通文本文件");
			const bytes = await readFile(path);
			if (bytes.includes(0)) throw new Error("二进制文件不进入文本修改记录");
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async #persist(): Promise<void> {
		await atomicJson(join(this.home, "changes.json"), this.#changes);
	}
	async capture<T>(turn: string, path: string, operation: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(async () => {
			const retained = this.#changes.reduce(
				(bytes, item) => bytes + Buffer.byteLength(item.before ?? "") + Buffer.byteLength(item.after ?? ""),
				0,
			);
			if (this.#changes.length >= 100 || retained > 18_000_000)
				throw new Error("本会话修改快照达到保留上限；请保存现有记录并新开会话");
			const canonical = await canonicalPath(path);
			if (!contained(await canonicalPath(this.workspace), canonical)) throw new Error("修改记录仅覆盖工作区");
			path = canonical;
			const before = await this.#text(path);
			const mode = before === null ? 0o644 : (await lstat(path)).mode & 0o777;
			try {
				return await operation();
			} finally {
				const after = await this.#text(path);
				if (before !== after) {
					this.#changes.push({
						id: randomUUID(),
						turn,
						path,
						before,
						after,
						mode,
						at: new Date().toISOString(),
						restored: false,
					});
					await this.#persist();
				}
			}
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}
	async restore(id: string): Promise<void> {
		await this.restoreMany([id]);
	}
	async restoreMany(
		ids: string[],
		validation?: { prepare: () => Promise<void>; beforeWrite: () => void },
	): Promise<void> {
		const run = this.#queue.then(async () => {
			await validation?.prepare();
			const selected = this.#changes.filter(x => ids.includes(x.id) && !x.restored);
			if (!ids.length || new Set(ids).size !== ids.length || selected.length !== ids.length)
				throw new Error("没有可恢复的完整修改记录");
			const groups = new Map<string, Change[]>();
			for (const change of selected) {
				const items = groups.get(change.path) ?? [];
				items.push(change);
				groups.set(change.path, items);
			}
			for (const [path, changes] of groups) {
				const canonical = await canonicalPath(path);
				if (!contained(await canonicalPath(this.workspace), canonical) || canonical !== path)
					throw new Error("恢复路径发生变化或超出工作区");
				if ((await this.#text(path)) !== changes.at(-1)!.after)
					throw new Error(`恢复冲突：${path} 已有新的修改，拒绝覆盖`);
				for (let index = 1; index < changes.length; index++)
					if (changes[index].before !== changes[index - 1].after)
						throw new Error("恢复冲突：选中的修改之间存在未包含的文件变更");
			}
			await atomicJson(join(this.home, "restore-backup.json"), selected);
			const restored: string[] = [];
			try {
				for (const [path, changes] of groups) {
					await validation?.prepare();
					const before = changes[0].before;
					if ((await this.#text(path)) !== changes.at(-1)!.after)
						throw new Error(`恢复冲突：预览后 ${path} 发生变化`);
					validation?.beforeWrite();
					if (before === null) await unlink(path);
					else {
						await mkdir(dirname(path), { recursive: true });
						validation?.beforeWrite();
						await writeFile(path, before);
						await chmod(path, changes[0].mode);
					}
					for (const change of changes) change.restored = true;
					restored.push(path);
					await this.#persist();
				}
			} catch (error) {
				await this.#persist();
				throw new Error(
					`${String(error)}；已恢复：${restored.join(", ") || "无"}；其他文件保持现状，临时备份保留在 ${this.home}`,
				);
			}
		});
		this.#queue = run.catch(() => undefined);
		await run;
	}
}
