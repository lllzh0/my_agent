import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Policy } from "../src/policy/policy.ts";
import { Search } from "../src/search/search.ts";

interface SearchFixture {
	root: string;
	workspace: string;
	policy: Policy;
	search: Search;
}

async function withSearch(run: (fixture: SearchFixture) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-search-"));
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace);
	const policy = new Policy(workspace, { readRoots: [], writeRoots: [], allowNetwork: false });
	try {
		await run({ root, workspace, policy, search: new Search(policy) });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("grep finds a unique regex match after the old first 500 files", () =>
	withSearch(async ({ workspace, search }) => {
		await Promise.all(
			Array.from({ length: 620 }, (_, index) =>
				Bun.write(
					path.join(workspace, `file-${String(index).padStart(4, "0")}.ts`),
					index === 619 ? "LATE_731\n" : "ordinary\n",
				),
			),
		);
		const result = await search.grep({ path: ".", pattern: "^LATE_[0-9]+$", glob: "*.ts" });
		expect(result.matches.map(row => [row.path, row.lineNumber, row.line])).toEqual([
			["file-0619.ts", 1, "LATE_731"],
		]);
		expect(result.filesSearched).toBe(620);
		expect(result.complete).toBe(true);
		expect(result.truncated).toBe(false);
		expect(result.nextOffset).toBeNull();
	}));

test("grep distinguishes literal text from regex and applies case and path globs", () =>
	withSearch(async ({ workspace, search }) => {
		await Bun.write(path.join(workspace, "src/main.ts"), "axb\na.b\nMiXeD [text]\n");
		await Bun.write(path.join(workspace, "src/nested/deep.ts"), "a.b\n");
		await Bun.write(path.join(workspace, "other/main.ts"), "a.b\n");
		const regex = await search.grep({ pattern: "a.b", glob: "src/*.ts" });
		expect(regex.matches.map(row => row.line)).toEqual(["axb", "a.b"]);
		const literal = await search.grep({ pattern: "a.b", literal: true, glob: "src/*.ts" });
		expect(literal.matches.map(row => [row.path, row.lineNumber])).toEqual([["src/main.ts", 2]]);
		const insensitive = await search.grep({ pattern: "mixed [text]", literal: true, ignoreCase: true });
		expect(insensitive.matches.map(row => row.line)).toEqual(["MiXeD [text]"]);
		const recursive = await search.find({ pattern: "*.ts" });
		expect(recursive.matches.map(row => row.path)).toEqual(["other/main.ts", "src/main.ts", "src/nested/deep.ts"]);
	}));

test("search honors gitignore and explicit hidden and gitignore overrides", () =>
	withSearch(async ({ workspace, search }) => {
		await Bun.write(path.join(workspace, ".gitignore"), "ignored.ts\nnested/ignored.ts\n");
		await Bun.write(path.join(workspace, "kept.ts"), "marker\n");
		await Bun.write(path.join(workspace, "ignored.ts"), "marker\n");
		await Bun.write(path.join(workspace, "nested/ignored.ts"), "marker\n");
		await Bun.write(path.join(workspace, ".hidden.ts"), "marker\n");
		const normal = await search.grep({ pattern: "marker", glob: "*.ts" });
		expect(normal.matches.map(row => row.path)).toEqual(["kept.ts"]);
		const all = await search.grep({ pattern: "marker", glob: "*.ts", hidden: true, gitignore: false });
		expect(all.matches.map(row => row.path)).toEqual([".hidden.ts", "ignored.ts", "kept.ts", "nested/ignored.ts"]);
		const found = await search.find({ glob: "*.ts", hidden: true });
		expect(found.matches.map(row => row.path)).toEqual([".hidden.ts", "kept.ts"]);
	}));

test("search excludes credentials, private state, caches, and symlinks without leaking their content", () =>
	withSearch(async ({ root, workspace, policy, search }) => {
		await Bun.write(path.join(workspace, "public.ts"), "needle PUBLIC\n");
		await Bun.write(path.join(workspace, ".env.example"), "needle EXAMPLE\n");
		await Bun.write(path.join(workspace, ".env"), "needle PRIVATE_ENV\n");
		await Bun.write(path.join(workspace, ".ssh/id_ed25519"), "needle PRIVATE_SSH\n");
		await Bun.write(path.join(workspace, "auth.json"), "needle PRIVATE_AUTH\n");
		await Bun.write(path.join(workspace, "state/cache.ts"), "needle PRIVATE_STATE\n");
		await Bun.write(path.join(workspace, ".my-agent/cache.ts"), "needle PRIVATE_APP\n");
		await Bun.write(path.join(workspace, ".cache/cache.ts"), "needle PRIVATE_CACHE\n");
		await Bun.write(path.join(root, "outside/secret.ts"), "needle PRIVATE_OUTSIDE\n");
		await fs.symlink(path.join(root, "outside/secret.ts"), path.join(workspace, "linked.ts"));
		await fs.symlink(path.join(root, "outside"), path.join(workspace, "linked-dir"));
		await fs.symlink(path.join(workspace, "public.ts"), path.join(workspace, "internal-link.ts"));
		policy.protectedRoots = [path.join(workspace, "state")];
		const result = await search.grep({ pattern: "needle", hidden: true, gitignore: false });
		expect(result.matches.map(row => row.path)).toEqual([".env.example", "public.ts"]);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_");
		expect(result.skipped.denied).toBeGreaterThan(0);
		expect(result.skipped.symlinks).toBeGreaterThan(0);
		expect(result.complete).toBe(false);
		const found = await search.find({ hidden: true, gitignore: false });
		expect(found.matches.map(row => row.path)).toEqual([".env.example", "public.ts"]);
	}));

test("gitignore discovery cannot read a forbidden symlink target before policy approval", () =>
	withSearch(async ({ root, workspace, search }) => {
		await Bun.write(path.join(workspace, "public.ts"), "visible\n");
		await Bun.write(path.join(root, "forbidden-ignore"), "public.ts\n");
		await fs.symlink(path.join(root, "forbidden-ignore"), path.join(workspace, ".gitignore"));
		const result = await search.grep({ pattern: "visible" });
		expect(result.matches.map(row => row.path)).toEqual(["public.ts"]);
	}));

test("grep reads the content approved by policy rather than content collected before its check", () =>
	withSearch(async ({ workspace }) => {
		const target = path.join(workspace, "changed.ts");
		await Bun.write(target, "BEFORE_APPROVAL\n");
		const canonicalTarget = await fs.realpath(target);
		class ContentPolicy extends Policy {
			override async resolvePath(input: string, kind: "read" | "write"): Promise<string> {
				const resolved = await super.resolvePath(input, kind);
				if (resolved === canonicalTarget) await Bun.write(target, "AFTER_APPROVAL\n");
				return resolved;
			}
		}
		const search = new Search(new ContentPolicy(workspace, { readRoots: [], writeRoots: [], allowNetwork: false }));
		const result = await search.grep({ pattern: "^AFTER_APPROVAL$" });
		expect(result.matches.map(row => row.line)).toEqual(["AFTER_APPROVAL"]);
	}));

test("find and grep expose resumable stable pages and distinguish the final exact-size page", () =>
	withSearch(async ({ workspace, search }) => {
		await Bun.write(path.join(workspace, "a.ts"), "match A1\nmatch A2\n");
		await Bun.write(path.join(workspace, "b.ts"), "match B\n");
		await Bun.write(path.join(workspace, "c.ts"), "match C\n");
		const first = await search.grep({ pattern: "match", limit: 2 });
		expect(first.matches.map(row => row.line)).toEqual(["match A1", "match A2"]);
		expect(first).toMatchObject({ complete: false, truncated: true, limitReached: true, nextOffset: 2 });
		const last = await search.grep({ pattern: "match", offset: first.nextOffset!, limit: 2 });
		expect(last.matches.map(row => row.line)).toEqual(["match B", "match C"]);
		expect(last).toMatchObject({
			complete: true,
			truncated: false,
			limitReached: false,
			nextOffset: null,
			totalMatches: 4,
			totalIsExact: true,
		});
		const files = await search.find({ pattern: "*.ts", limit: 2 });
		expect(files.matches.map(row => row.path)).toEqual(["a.ts", "b.ts"]);
		expect(files).toMatchObject({ complete: false, truncated: true, nextOffset: 2 });
		const tail = await search.find({ pattern: "*.ts", offset: files.nextOffset!, limit: 2 });
		expect(tail.matches.map(row => row.path)).toEqual(["c.ts"]);
		expect(tail).toMatchObject({ complete: true, truncated: false, nextOffset: null, totalMatches: 3 });
		const exact = await search.find({ pattern: "*.ts", limit: 3 });
		expect(exact).toMatchObject({ complete: true, truncated: false, nextOffset: null });
	}));

test("oversized files and truncated matching lines never report a complete absence", () =>
	withSearch(async ({ workspace, search }) => {
		await Bun.write(path.join(workspace, "huge.ts"), `${"x".repeat(4 * 1024 * 1024)}\nTAIL_MATCH\n`);
		const skipped = await search.grep({ pattern: "TAIL_MATCH" });
		expect(skipped.matches).toEqual([]);
		expect(skipped.skipped.oversized).toBe(1);
		expect(skipped).toMatchObject({ complete: false, truncated: true, nextOffset: null });
		await Bun.write(path.join(workspace, "wide.ts"), `${"x".repeat(2500)}VISIBLE_MATCH\n`);
		const wide = await search.grep({ path: "wide.ts", pattern: "VISIBLE_MATCH" });
		expect(wide.matches[0].line).toContain("VISIBLE_MATCH");
		expect(wide.matches[0].truncated).toBe(true);
		expect(wide).toMatchObject({ complete: false, truncated: true, nextOffset: null });
	}));

test("explicit forbidden and missing search roots reject rather than returning empty success", () =>
	withSearch(async ({ root, workspace, search }) => {
		await Bun.write(path.join(root, "outside.ts"), "outside\n");
		await Bun.write(path.join(workspace, ".env"), "secret\n");
		await expect(search.grep({ path: "../outside.ts", pattern: "outside" })).rejects.toThrow(/工作区|范围/);
		await expect(search.find({ path: ".env" })).rejects.toThrow(/凭据/);
		await expect(search.find({ path: "missing" })).rejects.toThrow();
	}));

test("unreadable files and directories mark the search incomplete instead of hiding missing evidence", () =>
	withSearch(async ({ workspace, search }) => {
		const directory = path.join(workspace, "locked");
		const file = path.join(workspace, "unreadable.ts");
		await Bun.write(path.join(directory, "inside.ts"), "needle\n");
		await Bun.write(file, "needle\n");
		await fs.chmod(directory, 0);
		await fs.chmod(file, 0);
		try {
			const result = await search.grep({ pattern: "needle", gitignore: false });
			expect(result.matches).toEqual([]);
			expect(result.complete).toBe(false);
			expect(result.skipped.unreadable).toBe(2);
			const found = await search.find({ gitignore: false });
			expect(found.complete).toBe(false);
			expect(found.skipped.unreadable).toBeGreaterThanOrEqual(1);
		} finally {
			await fs.chmod(directory, 0o700);
			await fs.chmod(file, 0o600);
		}
	}));

test("invalid regex fails even when the directory has no candidate files", () =>
	withSearch(async ({ search }) => {
		await expect(search.grep({ pattern: "[" })).rejects.toThrow(/regex|pattern|正则/i);
		await expect(search.grep({ pattern: "" })).rejects.toThrow(/pattern/);
	}));

test("native-only regex fallback cannot silently turn supported JavaScript syntax into literal search", () =>
	withSearch(async ({ workspace, search }) => {
		await Bun.write(path.join(workspace, "expressions.ts"), "echo echo\nprefix:word:suffix\n中文\n😀\n");
		for (const pattern of [
			"(?<word>\\w+)\\s+\\k<word>",
			"(\\w+) \\1",
			"(?<=prefix:)word(?=:suffix)",
			"\\p{Script=Han}+",
		])
			expect((await search.grep({ pattern })).matches).toHaveLength(1);
		// Both are valid Unicode JavaScript regexes that the native engines reject.
		for (const pattern of ["(?<\\u0061>a)\\k<a>", "\\uD83D\\uDE00"])
			await expect(search.grep({ pattern })).rejects.toThrow(/原生|native|不支持/i);
	}));

test("cancellation rejects before discovery and while a file is waiting for policy approval", () =>
	withSearch(async ({ workspace, search }) => {
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(search.find({}, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
		await expect(search.grep({ pattern: "needle" }, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
		await Bun.write(path.join(workspace, "a.ts"), "needle\n");
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		class WaitingPolicy extends Policy {
			override async resolvePath(input: string, kind: "read" | "write"): Promise<string> {
				const target = await super.resolvePath(input, kind);
				if (path.basename(target) === "a.ts") {
					entered.resolve();
					await resume.promise;
				}
				return target;
			}
		}
		const waiting = new Search(new WaitingPolicy(workspace, { readRoots: [], writeRoots: [], allowNetwork: false }));
		const controller = new AbortController();
		const pending = waiting.grep({ pattern: "needle" }, controller.signal);
		try {
			await entered.promise;
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			resume.resolve();
			await pending.catch(() => undefined);
		}
	}));

test("invalid paging cannot silently wrap native integer limits", () =>
	withSearch(async ({ search }) => {
		for (const offset of [-1, 0.5, Number.NaN, 0x1_0000_0000])
			await expect(search.find({ offset })).rejects.toThrow(/offset/);
		for (const limit of [0, -1, 0.5, 1001])
			await expect(search.grep({ pattern: "needle", limit })).rejects.toThrow(/limit/);
	}));
