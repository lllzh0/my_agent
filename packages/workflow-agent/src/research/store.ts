import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { digest, readJson, record } from "../storage";
import {
	type Source,
	type SourceBody,
	type SourceInfo,
	type StoredSource,
	type ResearchStats,
	SOURCE_LIMITS,
	SOURCE_RECENT_LIMIT,
	SOURCE_EXCERPT_LIMIT,
} from "./types";

interface SourceRow {
	metadata: string;
	data: string;
}

function legacySource(input: unknown): StoredSource {
	const value = record(input, "旧来源");
	if (
		typeof value.id !== "string" ||
		!/^S[1-9]\d*$/.test(value.id) ||
		!Number.isSafeInteger(Number(value.id.slice(1))) ||
		typeof value.title !== "string" ||
		typeof value.retrievedAt !== "string" ||
		typeof value.text !== "string" ||
		typeof value.read !== "boolean"
	)
		throw new Error("旧来源迁移失败：ID、标题、时间、正文或读取状态无效");
	for (const key of ["url", "finalUrl", "path", "publishedAt"])
		if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`旧来源迁移失败：${key} 无效`);
	const pages = value.pages;
	if (
		pages !== undefined &&
		(!Array.isArray(pages) ||
			pages.some(page => {
				const item = record(page, "旧来源页码");
				return !Number.isInteger(item.page) || Number(item.page) < 1 || typeof item.text !== "string";
			}))
	)
		throw new Error("旧来源迁移失败：页码无效");
	const source = value as unknown as Omit<StoredSource, "coverage">;
	return {
		...source,
		coverage: {
			acquisition: "legacy",
			fetchedBytes: null,
			fetchTruncated: null,
			extractedChars: source.text.length,
			totalChars: null,
			extractionTruncated: null,
			...(source.pages ? { extractedPages: source.pages.length } : {}),
			limits: { ...SOURCE_LIMITS },
		},
	};
}

/** Immutable source metadata and content-addressed bodies. No automatic evidence deletion. */
export class SourceStore {
	readonly #db: Database;
	constructor(file: string) {
		this.#db = new Database(file, { create: true, strict: true });
		try {
			const version = this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
			if (version !== 0 && version !== 1) throw new Error("来源数据库版本不支持");
			this.#db.exec(`
				PRAGMA foreign_keys = ON;
				PRAGMA busy_timeout = 5000;
				CREATE TABLE IF NOT EXISTS source_content (hash TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS sources (
					sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, identity TEXT NOT NULL,
					fingerprint TEXT NOT NULL, metadata TEXT NOT NULL, excerpt TEXT NOT NULL,
					content_hash TEXT NOT NULL REFERENCES source_content(hash)
				);
				CREATE INDEX IF NOT EXISTS source_identity ON sources(identity, fingerprint);
				CREATE TABLE IF NOT EXISTS source_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				INSERT OR IGNORE INTO source_meta VALUES ('next_id', '1');
				PRAGMA user_version = 1;
			`);
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}
	static async open(home: string): Promise<SourceStore> {
		await fs.mkdir(home, { recursive: true, mode: 0o700 });
		const file = path.join(home, "sources.sqlite");
		const store = new SourceStore(file);
		try {
			await fs.chmod(file, 0o600);
			if (!store.#db.query("SELECT value FROM source_meta WHERE key = 'legacy_imported'").get()) {
				const legacy = await readJson(path.join(home, "sources.json"));
				if (legacy !== undefined && !Array.isArray(legacy))
					throw new Error("旧来源迁移失败：sources.json 必须是列表");
				store.#db
					.transaction(() => {
						if (store.#db.query("SELECT value FROM source_meta WHERE key = 'legacy_imported'").get()) return;
						for (const item of legacy ?? []) store.#insert(legacySource(item));
						store.#db.run("INSERT INTO source_meta VALUES ('legacy_imported', '1')");
					})
					.immediate();
			}
			return store;
		} catch (error) {
			store.close();
			throw error;
		}
	}
	#parts(source: StoredSource) {
		const { text, pages, ...info } = source;
		const body: SourceBody = { text, ...(pages ? { pages } : {}) };
		const data = JSON.stringify(body);
		const hash = digest(data);
		const { id: _id, retrievedAt: _time, ...version } = info;
		const identity = source.path ? `file:${source.path}` : `url:${source.finalUrl ?? source.url ?? source.title}`;
		return { info, data, hash, identity, fingerprint: digest(JSON.stringify({ ...version, hash })) };
	}
	#insert(source: StoredSource): void {
		const { info, data, hash, identity, fingerprint } = this.#parts(source);
		this.#db.run("INSERT OR IGNORE INTO source_content VALUES (?, ?, ?)", [hash, data, Buffer.byteLength(data)]);
		this.#db.run(
			"INSERT INTO sources(id, identity, fingerprint, metadata, excerpt, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
			[source.id, identity, fingerprint, JSON.stringify(info), source.text.slice(0, SOURCE_EXCERPT_LIMIT), hash],
		);
		const next = Number(source.id.slice(1)) + 1;
		if (!Number.isSafeInteger(next)) throw new Error("来源 ID 已达可表示上限");
		this.#db.run(
			"UPDATE source_meta SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'next_id'",
			[next],
		);
	}
	add(input: Omit<StoredSource, "id" | "retrievedAt">): StoredSource {
		return this.#db.transaction(() => {
			const source = { ...input, id: "", retrievedAt: new Date().toISOString() };
			const { identity, fingerprint } = this.#parts(source);
			const existing = this.#db
				.query<{ id: string }, [string, string]>(
					"SELECT id FROM sources WHERE identity = ? AND fingerprint = ? ORDER BY sequence LIMIT 1",
				)
				.get(identity, fingerprint);
			if (existing) return this.get(existing.id)!;
			const next = this.#db
				.query<{ value: string }, []>("SELECT value FROM source_meta WHERE key = 'next_id'")
				.get()!.value;
			source.id = `S${next}`;
			this.#insert(source);
			return source;
		})();
	}
	get(id: string): StoredSource | undefined {
		const row = this.#db
			.query<SourceRow, [string]>(
				"SELECT metadata, data FROM sources JOIN source_content ON content_hash = hash WHERE id = ?",
			)
			.get(id);
		return row ? { ...(JSON.parse(row.metadata) as SourceInfo), ...(JSON.parse(row.data) as SourceBody) } : undefined;
	}
	info(id: string): SourceInfo | undefined {
		const row = this.#db.query<{ metadata: string }, [string]>("SELECT metadata FROM sources WHERE id = ?").get(id);
		return row ? (JSON.parse(row.metadata) as SourceInfo) : undefined;
	}
	recent(): Source[] {
		return this.#db
			.query<{ metadata: string; excerpt: string }, [number]>(
				"SELECT metadata, excerpt FROM sources ORDER BY sequence DESC LIMIT ?",
			)
			.all(SOURCE_RECENT_LIMIT)
			.map(row => {
				const info = JSON.parse(row.metadata) as SourceInfo;
				return {
					...info,
					text: row.excerpt,
					range: {
						offset: 1,
						end: row.excerpt.length,
						totalChars: info.coverage.extractedChars,
						...(row.excerpt.length < info.coverage.extractedChars ? { nextOffset: row.excerpt.length + 1 } : {}),
						truncated: row.excerpt.length < info.coverage.extractedChars,
					},
				};
			});
	}
	stats(): ResearchStats {
		const sourceCount = this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sources").get()!.count;
		const content = this.#db
			.query<{ count: number; bytes: number }, []>(
				"SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM source_content",
			)
			.get()!;
		const pages = this.#db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
		const size = this.#db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
		return {
			sourceCount,
			contentCount: content.count,
			contentBytes: content.bytes,
			databaseBytes: pages * size,
			recentCount: Math.min(sourceCount, SOURCE_RECENT_LIMIT),
		};
	}
	close(): void {
		this.#db.close();
	}
}
