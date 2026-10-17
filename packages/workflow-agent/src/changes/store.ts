import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openSqliteDatabase } from "@oh-my-pi/pi-utils/sqlite";
import { digest, readJson, record } from "../storage.ts";
import type { Change } from "./journal.ts";

export interface JournalStats {
	changes: number;
	pending: number;
	snapshots: number;
	snapshotBytes: number;
	referencedBytes: number;
	databaseBytes: number;
	schemaVersion: 1;
}

interface ChangeRow {
	id: string;
	turn: string;
	path: string;
	before: string | null;
	after: string | null;
	mode: number;
	at: string;
	restored: number;
}

const CHANGE_SELECT = `SELECT c.id, c.turn, c.path, b.content AS before, a.content AS after, c.mode, c.at, c.restored
	FROM changes c
	LEFT JOIN snapshots b ON b.hash = c.before_hash
	LEFT JOIN snapshots a ON a.hash = c.after_hash`;

function changeFromRow(row: ChangeRow): Change {
	return { ...row, restored: row.restored === 1 };
}

function legacyChange(value: unknown): Change {
	const item = record(value, "旧修改记录");
	if (
		typeof item.id !== "string" ||
		!item.id ||
		typeof item.turn !== "string" ||
		typeof item.path !== "string" ||
		!item.path ||
		(item.before !== null && typeof item.before !== "string") ||
		(item.after !== null && typeof item.after !== "string") ||
		typeof item.mode !== "number" ||
		!Number.isInteger(item.mode) ||
		item.mode < 0 ||
		item.mode > 0o777 ||
		typeof item.at !== "string" ||
		typeof item.restored !== "boolean"
	)
		throw new Error("旧修改记录格式无效；原文件已保留");
	return {
		id: item.id,
		turn: item.turn,
		path: item.path,
		before: item.before,
		after: item.after,
		mode: item.mode,
		at: item.at,
		restored: item.restored,
	};
}

/** Metadata stays in SQLite; snapshot text is joined only for the requested rows. */
export class JournalStore {
	#db: Database;
	#path: string;

	constructor(db: Database, databasePath: string) {
		this.#db = db;
		this.#path = databasePath;
	}

	static async open(home: string): Promise<JournalStore> {
		await fs.mkdir(home, { recursive: true, mode: 0o700 });
		const databasePath = path.join(home, "changes.sqlite");
		return openSqliteDatabase(databasePath, async db => {
			await fs.chmod(databasePath, 0o600);
			db.run("PRAGMA foreign_keys = ON");
			db.run("PRAGMA journal_mode = WAL");
			db.run("PRAGMA synchronous = FULL");
			const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
			if (version !== 0 && version !== 1) throw new Error(`修改记录数据库版本 ${version} 不受支持`);
			db.transaction(() => {
				db.run(`CREATE TABLE IF NOT EXISTS snapshots (
					hash TEXT PRIMARY KEY, content TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0)
				)`);
				db.run(`CREATE TABLE IF NOT EXISTS changes (
					seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
					turn TEXT NOT NULL, path TEXT NOT NULL,
					before_hash TEXT REFERENCES snapshots(hash), after_hash TEXT REFERENCES snapshots(hash),
					mode INTEGER NOT NULL, at TEXT NOT NULL, restored INTEGER NOT NULL CHECK(restored IN (0, 1))
				)`);
				db.run("CREATE INDEX IF NOT EXISTS changes_pending ON changes(restored, seq)");
				db.run("CREATE INDEX IF NOT EXISTS changes_turn ON changes(turn, restored, seq)");
				db.run("CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
				db.run("PRAGMA user_version = 1");
			})();
			const store = new JournalStore(db, databasePath);
			const migrated = db
				.query<{ value: string }, []>("SELECT value FROM journal_meta WHERE key = 'legacy_changes_json'")
				.get();
			if (!migrated) {
				const legacy = await readJson(path.join(home, "changes.json"));
				if (legacy !== undefined && !Array.isArray(legacy)) throw new Error("旧修改记录必须是数组；原文件已保留");
				db.transaction(() => {
					// Recheck inside the transaction if a second opener completed migration while reading JSON.
					if (
						db
							.query<{ value: string }, []>("SELECT value FROM journal_meta WHERE key = 'legacy_changes_json'")
							.get()
					)
						return;
					for (const value of legacy ?? []) store.#insert(legacyChange(value));
					db.run("INSERT INTO journal_meta (key, value) VALUES ('legacy_changes_json', ?)", [
						legacy === undefined ? "absent" : "imported",
					]);
				}).immediate();
			}
			return store;
		});
	}

	#snapshot(content: string | null): string | null {
		if (content === null) return null;
		const hash = digest(content);
		this.#db
			.query("INSERT OR IGNORE INTO snapshots (hash, content, bytes) VALUES (?, ?, ?)")
			.run(hash, content, Buffer.byteLength(content));
		return hash;
	}

	#insert(change: Change): void {
		const before = this.#snapshot(change.before);
		const after = this.#snapshot(change.after);
		this.#db
			.query(`INSERT INTO changes (id, turn, path, before_hash, after_hash, mode, at, restored)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(change.id, change.turn, change.path, before, after, change.mode, change.at, Number(change.restored));
	}

	append(change: Change): void {
		this.#db.transaction(() => this.#insert(change))();
	}

	list(): Change[] {
		return this.#db
			.query<ChangeRow, []>(`${CHANGE_SELECT} ORDER BY c.seq DESC LIMIT 100`)
			.all()
			.reverse()
			.map(changeFromRow);
	}

	find(id: string): Change | undefined {
		const row = this.#db.query<ChangeRow, [string]>(`${CHANGE_SELECT} WHERE c.id = ?`).get(id);
		return row ? changeFromRow(row) : undefined;
	}

	latestTurn(): Change[] {
		return this.#db
			.query<ChangeRow, []>(`${CHANGE_SELECT}
			WHERE c.restored = 0 AND c.turn = (SELECT turn FROM changes WHERE restored = 0 ORDER BY seq DESC LIMIT 1)
			ORDER BY c.seq`)
			.all()
			.map(changeFromRow);
	}

	select(ids: string[]): Change[] {
		return this.#db
			.query<ChangeRow, [string]>(`${CHANGE_SELECT}
			WHERE c.restored = 0 AND c.id IN (SELECT value FROM json_each(?)) ORDER BY c.seq`)
			.all(JSON.stringify(ids))
			.map(changeFromRow);
	}

	markRestored(ids: string[]): void {
		this.#db
			.query("UPDATE changes SET restored = 1 WHERE id IN (SELECT value FROM json_each(?))")
			.run(JSON.stringify(ids));
	}

	async stats(): Promise<JournalStats> {
		const changes = this.#db
			.query<{ changes: number; pending: number }, []>(
				"SELECT COUNT(*) AS changes, COALESCE(SUM(1 - restored), 0) AS pending FROM changes",
			)
			.get()!;
		const snapshots = this.#db
			.query<{ snapshots: number; snapshotBytes: number }, []>(
				"SELECT COUNT(*) AS snapshots, COALESCE(SUM(bytes), 0) AS snapshotBytes FROM snapshots",
			)
			.get()!;
		const referenced = this.#db
			.query<{ referencedBytes: number }, []>(`SELECT
			COALESCE(SUM(COALESCE(b.bytes, 0) + COALESCE(a.bytes, 0)), 0) AS referencedBytes
			FROM changes c LEFT JOIN snapshots b ON b.hash = c.before_hash LEFT JOIN snapshots a ON a.hash = c.after_hash`)
			.get()!;
		const sizes = await Promise.all(
			["", "-wal", "-shm"].map(async suffix => {
				try {
					return (await fs.stat(`${this.#path}${suffix}`)).size;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
					throw error;
				}
			}),
		);
		return {
			...changes,
			...snapshots,
			...referenced,
			databaseBytes: sizes.reduce((sum, size) => sum + size, 0),
			schemaVersion: 1,
		};
	}

	close(): void {
		this.#db.close();
	}
}
