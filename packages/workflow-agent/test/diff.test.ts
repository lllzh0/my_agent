import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Policy } from "../src/policy/policy";
import { collectProductDiff } from "../src/review/diff";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw new Error(error);
	return out.trim();
}

async function withRepo(run: (cwd: string, policy: Policy) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-diff-"));
	try {
		await git(root, "init", "-b", "main");
		await git(root, "config", "user.name", "Diff Fixture");
		await git(root, "config", "user.email", "diff@example.test");
		await Bun.write(path.join(root, "tracked.ts"), "const value = 1;\n");
		await Bun.write(path.join(root, "deleted.ts"), "removed later\n");
		await Bun.write(path.join(root, ".env"), "PRIVATE_OLD\n");
		await git(root, "add", ".");
		await git(root, "commit", "-m", "fixture");
		await run(root, new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false }));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("project diff preserves staged and unstaged versions, new and deleted files without touching index", () =>
	withRepo(async (cwd, policy) => {
		await Bun.write(path.join(cwd, "tracked.ts"), "const value = 2;\n");
		await git(cwd, "add", "tracked.ts");
		await Bun.write(path.join(cwd, "tracked.ts"), "const value = 3;\n");
		await Bun.write(path.join(cwd, "new.ts"), "new source\n");
		await fs.rm(path.join(cwd, "deleted.ts"));
		const before = await fs.readFile(path.join(cwd, ".git/index"));
		const snapshot = await collectProductDiff({ cwd, policy, home: path.join(cwd, "private-state") });
		expect(snapshot.files.map(file => [file.path, file.stage])).toEqual([
			["tracked.ts", "staged"],
			["deleted.ts", "unstaged"],
			["tracked.ts", "unstaged"],
			["new.ts", "untracked"],
		]);
		expect(snapshot.patch).toContain("-const value = 1;");
		expect(snapshot.patch).toContain("+const value = 2;");
		expect(snapshot.patch).toContain("+const value = 3;");
		expect(snapshot.patch).toContain("-removed later");
		expect(snapshot.patch).toContain("+new source");
		// The tracked credential file is deliberately not opened to determine
		// whether it changed, so coverage remains conservative.
		expect(snapshot.complete).toBe(false);
		expect(snapshot.excluded.some(item => item.reason === "permission")).toBe(true);
		expect(await fs.readFile(path.join(cwd, ".git/index"))).toEqual(before);
	}));

test("diff excludes credentials, private state, binary, symlinks and renamed secret history even in full access", () =>
	withRepo(async (cwd, policy) => {
		policy.setApprovalMode("full");
		await git(cwd, "mv", ".env", "renamed.ts");
		await Bun.write(path.join(cwd, "renamed.ts"), "public replacement\n");
		await git(cwd, "add", "renamed.ts");
		await Bun.write(path.join(cwd, "private-state/cache.ts"), "PRIVATE_STATE");
		await Bun.write(path.join(cwd, "image.bin"), Buffer.from([0, 1, 2, 3]));
		await fs.symlink(path.join(cwd, "renamed.ts"), path.join(cwd, "link.ts"));
		const result = await collectProductDiff({ cwd, policy, home: path.join(cwd, "private-state") });
		expect(result.patch).toContain("+public replacement");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_");
		expect(result.complete).toBe(false);
		expect(result.excluded.some(item => item.reason === "binary")).toBe(true);
		expect(result.excluded.some(item => item.reason === "symlink")).toBe(true);
		expect(result.excluded.some(item => item.reason === "permission")).toBe(true);
	}));

test("base diff uses the frozen local revision and does not include sibling workspace contents", () =>
	withRepo(async (cwd, _policy) => {
		await Bun.write(path.join(cwd, "nested/inside.ts"), "before\n");
		await git(cwd, "add", "nested");
		await git(cwd, "commit", "-m", "nested");
		await Bun.write(path.join(cwd, "nested/inside.ts"), "after\n");
		await Bun.write(path.join(cwd, "tracked.ts"), "SIBLING_PRIVATE\n");
		const nested = await fs.realpath(path.join(cwd, "nested"));
		const policy = new Policy(nested, { readRoots: [], writeRoots: [], allowNetwork: false });
		const result = await collectProductDiff({ cwd: nested, policy, home: path.join(cwd, "state") }, "HEAD");
		expect(result.patch).toContain("-before");
		expect(result.patch).toContain("+after");
		expect(JSON.stringify(result)).not.toContain("SIBLING_PRIVATE");
		expect(result.base).toMatch(/^[a-f0-9]{40,64}$/);
		await expect(collectProductDiff({ cwd, policy, home: path.join(cwd, "state") }, "missing-ref")).rejects.toThrow();
	}));

test("diff reports oversized and file-limited coverage and honours cancellation", () =>
	withRepo(async (cwd, policy) => {
		await Bun.write(path.join(cwd, "huge.ts"), "line\n".repeat(100_000));
		for (let i = 0; i < 3; i++) await Bun.write(path.join(cwd, `${i}.ts`), "small\n");
		const state = { cwd, policy, home: path.join(cwd, "private-state") };
		const bounded = await collectProductDiff(state, undefined, undefined, { maxFiles: 10, maxBytes: 256 });
		expect(bounded.complete).toBe(false);
		expect(Buffer.byteLength(bounded.patch)).toBeLessThanOrEqual(256);
		expect(bounded.excluded.some(item => item.reason === "size")).toBe(true);
		const limited = await collectProductDiff(state, undefined, undefined, { maxFiles: 1 });
		expect(limited.files).toHaveLength(1);
		expect(limited.complete).toBe(false);
		await expect(collectProductDiff(state, undefined, AbortSignal.abort())).rejects.toThrow();
	}));

test("project diff never executes Git clean filters or writes loose Git objects", () =>
	withRepo(async (cwd, policy) => {
		await Bun.write(path.join(cwd, ".gitattributes"), "*.ts filter=fixture\n");
		await git(cwd, "add", ".gitattributes");
		await git(cwd, "commit", "-m", "attributes");
		const sentinel = path.join(cwd, "filter-side-effect");
		await git(cwd, "config", "filter.fixture.clean", `touch '${sentinel}'; cat`);
		await Bun.write(path.join(cwd, "tracked.ts"), "CHANGED_WITH_FILTER\n");
		const objects = path.join(cwd, ".git/objects");
		const before = (await fs.readdir(objects, { recursive: true })).sort();
		const result = await collectProductDiff({ cwd, policy, home: path.join(cwd, "private-state") });
		expect(await Bun.file(sentinel).exists()).toBe(false);
		expect((await fs.readdir(objects, { recursive: true })).sort()).toEqual(before);
		expect(result.patch).toContain("CHANGED_WITH_FILTER");
	}));

test("staged executable-bit change is visible even when text is unchanged", () =>
	withRepo(async (cwd, policy) => {
		await git(cwd, "update-index", "--chmod=+x", "tracked.ts");
		const result = await collectProductDiff({ cwd, policy, home: path.join(cwd, "private-state") });
		expect(result.files.some(file => file.path === "tracked.ts" && file.stage === "staged")).toBe(true);
		expect(result.patch).toContain("old mode 100644");
		expect(result.patch).toContain("new mode 100755");
	}));

test("clean ordinary repository is fully covered despite excluded Git metadata", () =>
	withRepo(async (cwd, policy) => {
		await git(cwd, "rm", ".env");
		await git(cwd, "commit", "-m", "remove credential fixture");
		const result = await collectProductDiff({ cwd, policy, home: path.join(cwd, "private-state") });
		expect(result.files).toHaveLength(0);
		expect(result.complete).toBe(true);
		expect(result.excluded).toHaveLength(0);
	}));
