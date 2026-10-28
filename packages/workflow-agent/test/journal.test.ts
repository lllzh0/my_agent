import assert from "node:assert/strict";
import { test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeJournal, type Change } from "../src/changes/journal.ts";

interface JournalFixture {
	root: string;
	workspace: string;
	home: string;
	open(validatePath?: (canonicalPath: string) => void | Promise<void>): ChangeJournal;
}

async function withJournal(run: (fixture: JournalFixture) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-journal-")));
	const workspace = path.join(root, "work");
	const home = path.join(root, "state");
	const journals: ChangeJournal[] = [];
	await fs.mkdir(workspace);
	try {
		await run({
			root,
			workspace,
			home,
			open(validatePath) {
				const journal = new ChangeJournal(home, workspace, validatePath);
				journals.push(journal);
				return journal;
			},
		});
	} finally {
		for (const journal of journals) await journal.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("journal keeps recording after 100 changes and restores a complete large turn", async () => {
	await withJournal(async ({ workspace, open }) => {
		const target = path.join(workspace, "large-turn.txt");
		await Bun.write(target, "original");
		const journal = open();
		let firstId = "";
		for (let index = 0; index < 105; index++) {
			await journal.capture("large-turn", target, () => Bun.write(target, `revision ${index}`));
			if (index === 0) firstId = journal.list()[0].id;
		}
		assert.equal(await Bun.file(target).text(), "revision 104");
		assert.equal(journal.list().length, 100);
		assert.equal(journal.latestTurn().length, 105);
		assert.match(journal.diff(firstId), /\n-original\n/);
		assert.match(journal.diff(firstId), /\n\+revision 0\n/);
		await journal.close();
		const reopened = open();
		await reopened.load();
		assert.equal(reopened.latestTurn().length, 105);
		await reopened.restoreMany(reopened.latestTurn().map(change => change.id));
		assert.equal(await Bun.file(target).text(), "original");
		assert.deepEqual(reopened.latestTurn(), []);
		assert.equal((await reopened.stats()).pending, 0);
	});
});

test("retained snapshots may exceed the former byte limit while repeated contents share storage", async () => {
	await withJournal(async ({ workspace, open }) => {
		const target = path.join(workspace, "repeated.txt");
		await Bun.write(target, "a".repeat(950_000));
		const journal = open();
		for (let index = 0; index < 14; index++)
			await journal.capture("repeated", target, () => Bun.write(target, (index % 2 ? "a" : "b").repeat(950_000)));
		await journal.close();
		const reopened = open();
		await reopened.load();
		const stats = await reopened.stats();
		assert.equal(stats.changes, 14);
		assert.equal(stats.pending, 14);
		assert.equal(stats.snapshots, 2);
		assert.equal(stats.snapshotBytes, 1_900_000);
		assert.equal(stats.referencedBytes, 26_600_000);
		assert.ok(stats.databaseBytes > 0);
		assert.equal(stats.schemaVersion, 1);
		await reopened.restoreMany(reopened.latestTurn().map(change => change.id));
		assert.equal(await Bun.file(target).text(), "a".repeat(950_000));
	});
});

test("legacy migration preserves IDs, snapshots and original JSON without importing it twice", async () => {
	await withJournal(async ({ workspace, home, open }) => {
		const target = path.join(workspace, "legacy.txt");
		await Bun.write(target, "gamma");
		const legacy: Change[] = [
			{
				id: "legacy-1",
				turn: "old-run",
				path: target,
				before: "alpha",
				after: "beta",
				mode: 0o640,
				at: "2026-10-15T00:00:00.000Z",
				restored: false,
			},
			{
				id: "legacy-2",
				turn: "old-run",
				path: target,
				before: "beta",
				after: "gamma",
				mode: 0o640,
				at: "2026-10-15T00:00:01.000Z",
				restored: false,
			},
		];
		const original = JSON.stringify(legacy, null, 2);
		await Bun.write(path.join(home, "changes.json"), original);
		const journal = open();
		await journal.load();
		assert.deepEqual(journal.list(), legacy);
		assert.equal((await journal.stats()).snapshots, 3);
		assert.equal((await journal.stats()).snapshotBytes, 14);
		assert.equal((await journal.stats()).referencedBytes, 18);
		await journal.restoreMany(["legacy-1", "legacy-2"]);
		assert.equal(await Bun.file(target).text(), "alpha");
		assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
		await journal.close();
		const reopened = open();
		await reopened.load();
		assert.deepEqual(reopened.latestTurn(), []);
		assert.equal((await reopened.stats()).changes, 2);
		assert.equal(await Bun.file(path.join(home, "changes.json")).text(), original);
	});
});

test("failed legacy import rolls back every row and can be retried from the untouched original", async () => {
	await withJournal(async ({ workspace, home, open }) => {
		const target = path.join(workspace, "legacy.txt");
		const first: Change = {
			id: "duplicate",
			turn: "old",
			path: target,
			before: "alpha",
			after: "beta",
			mode: 0o644,
			at: "2026-10-15T00:00:00.000Z",
			restored: false,
		};
		const original = JSON.stringify([first, { ...first, after: "orphan snapshot" }]);
		const legacyPath = path.join(home, "changes.json");
		await Bun.write(legacyPath, original);
		const broken = open();
		await assert.rejects(broken.load(), /重复|UNIQUE|duplicate/i);
		assert.equal(await Bun.file(legacyPath).text(), original);
		await broken.close();
		await Bun.write(legacyPath, JSON.stringify([first]));
		const recovered = open();
		await recovered.load();
		assert.deepEqual(recovered.list(), [first]);
		assert.equal((await recovered.stats()).snapshots, 2);
	});
});

test("latest turn skips restored runs and never overwrites a newer manual edit", async () => {
	await withJournal(async ({ workspace, open }) => {
		const earlier = path.join(workspace, "earlier.txt");
		const later = path.join(workspace, "later.txt");
		await Bun.write(earlier, "earlier original");
		await Bun.write(later, "later original");
		const journal = open();
		await journal.capture("earlier", earlier, () => Bun.write(earlier, "agent earlier"));
		await journal.capture("later", later, () => Bun.write(later, "agent later"));
		await Bun.write(later, "human later");
		await assert.rejects(journal.restoreMany(journal.latestTurn().map(change => change.id)), /冲突/);
		assert.equal(await Bun.file(later).text(), "human later");
		assert.equal((await journal.stats()).pending, 2);
		await Bun.write(later, "agent later");
		await journal.restoreMany(journal.latestTurn().map(change => change.id));
		assert.deepEqual(
			journal.latestTurn().map(change => change.turn),
			["earlier"],
		);
		await journal.restoreMany(journal.latestTurn().map(change => change.id));
		assert.equal(await Bun.file(earlier).text(), "earlier original");
		assert.equal(await Bun.file(later).text(), "later original");
	});
});

test("default journal rejects external paths and symlink escapes before an operation runs", async () => {
	await withJournal(async ({ root, workspace, open }) => {
		const outside = path.join(root, "outside.txt");
		await Bun.write(outside, "private original");
		await fs.symlink(outside, path.join(workspace, "escape.txt"));
		const journal = open();
		for (const target of [outside, path.join(workspace, "escape.txt")])
			await assert.rejects(
				journal.capture("escape", target, () => Bun.write(target, "overwritten")),
				/工作区/,
			);
		assert.equal(await Bun.file(outside).text(), "private original");
		assert.equal((await journal.stats()).changes, 0);
	});
});

test("an external path callback is checked again during restore and is not a persisted permission", async () => {
	await withJournal(async ({ root, open }) => {
		const outside = path.join(root, "outside.txt");
		await Bun.write(outside, "outside original");
		let allowed = true;
		const journal = open(target => {
			if (!allowed || target !== outside) throw new Error("未授权路径");
		});
		await journal.capture("external", outside, () => Bun.write(outside, "outside agent"));
		const id = journal.latestTurn()[0].id;
		allowed = false;
		await assert.rejects(journal.restore(id), /未授权/);
		assert.equal(await Bun.file(outside).text(), "outside agent");
		await journal.close();
		const reopened = open();
		await reopened.load();
		await assert.rejects(reopened.restore(id), /工作区/);
		assert.equal(await Bun.file(outside).text(), "outside agent");
	});
});

test("restore rejects a replaced parent directory before writing through a new symlink", async () => {
	await withJournal(async ({ root, workspace, open }) => {
		const parent = path.join(workspace, "nested");
		const outside = path.join(root, "outside");
		await fs.mkdir(parent);
		await fs.mkdir(outside);
		const target = path.join(parent, "file.txt");
		await Bun.write(target, "original");
		await Bun.write(path.join(outside, "file.txt"), "outside original");
		const journal = open();
		await journal.capture("replaced", target, () => Bun.write(target, "agent"));
		await fs.rename(parent, `${parent}-original`);
		await fs.symlink(outside, parent);
		await assert.rejects(journal.restore(journal.latestTurn()[0].id), /路径|工作区/);
		assert.equal(await Bun.file(path.join(outside, "file.txt")).text(), "outside original");
		assert.equal(await Bun.file(path.join(`${parent}-original`, "file.txt")).text(), "agent");
	});
});

test("partial restore persists successful files and can resume the remainder after reopen", async () => {
	await withJournal(async ({ workspace, open }) => {
		const a = path.join(workspace, "a.txt");
		const b = path.join(workspace, "b.txt");
		await Bun.write(a, "original a");
		await Bun.write(b, "original b");
		const journal = open();
		await journal.capture("partial", a, () => Bun.write(a, "agent a"));
		await journal.capture("partial", b, () => Bun.write(b, "agent b"));
		let prepares = 0;
		await assert.rejects(
			journal.restoreMany(
				journal.latestTurn().map(change => change.id),
				{
					prepare: async () => {
						if (++prepares === 3) throw new Error("暂停恢复");
					},
					beforeWrite: () => {},
				},
			),
			/已恢复：.*a\.txt/,
		);
		assert.equal(await Bun.file(a).text(), "original a");
		assert.equal(await Bun.file(b).text(), "agent b");
		await journal.close();
		await Bun.write(a, "new human a");
		const reopened = open();
		await reopened.load();
		assert.deepEqual(
			reopened.latestTurn().map(change => change.path),
			[b],
		);
		await reopened.restoreMany(reopened.latestTurn().map(change => change.id));
		assert.equal(await Bun.file(a).text(), "new human a");
		assert.equal(await Bun.file(b).text(), "original b");
		assert.equal((await reopened.stats()).pending, 0);
	});
});

test("a failed capture records its actual edit and does not reorder the next queued operation", async () => {
	await withJournal(async ({ workspace, open }) => {
		const target = path.join(workspace, "queued.txt");
		await Bun.write(target, "original");
		const journal = open();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = journal.capture("queued", target, async () => {
			started.resolve();
			await release.promise;
			await Bun.write(target, "first");
			throw new Error("operation failed after write");
		});
		await started.promise;
		const second = journal.capture("queued", target, () => Bun.write(target, "second"));
		release.resolve();
		await assert.rejects(first, /operation failed/);
		await second;
		assert.equal(await Bun.file(target).text(), "second");
		assert.deepEqual(
			journal.latestTurn().map(change => [change.before, change.after]),
			[
				["original", "first"],
				["first", "second"],
			],
		);
		await journal.restoreMany(journal.latestTurn().map(change => change.id));
		assert.equal(await Bun.file(target).text(), "original");
	});
});

test("close drains a pending capture and rejects later operations without side effects", async () => {
	await withJournal(async ({ workspace, open }) => {
		const target = path.join(workspace, "closing.txt");
		await Bun.write(target, "original");
		const journal = open();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const capture = journal.capture("closing", target, async () => {
			started.resolve();
			await release.promise;
			await Bun.write(target, "before close");
		});
		await started.promise;
		const closed = journal.close();
		await assert.rejects(
			journal.capture("too late", target, () => Bun.write(target, "late")),
			/关闭/,
		);
		release.resolve();
		await capture;
		await closed;
		const reopened = open();
		await reopened.load();
		assert.equal(await Bun.file(target).text(), "before close");
		assert.deepEqual(
			reopened.latestTurn().map(change => change.after),
			["before close"],
		);
	});
});

test("BOM snapshot bytes survive database reopen and restore", async () => {
	await withJournal(async ({ workspace, open }) => {
		const target = path.join(workspace, "bom.txt");
		const original = "\uFEFFfirst\r\nsecond\r\n";
		const updated = "\uFEFFupdated\r\nsecond\r\n";
		await Bun.write(target, original);
		const journal = open();
		await journal.capture("bom", target, () => Bun.write(target, updated));
		await journal.close();
		const reopened = open();
		await reopened.load();
		assert.equal(reopened.latestTurn()[0]!.before, original);
		assert.equal(reopened.latestTurn()[0]!.after, updated);
		await reopened.restore(reopened.latestTurn()[0]!.id);
		assert.equal(await fs.readFile(target, "utf8"), original);
	});
});
