import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { changePreview } from "../src/changes/preview";
import type { Request } from "../src/policy/policy";
import { formatApproval } from "../src/tui/operation-preview";
import { toolFixture } from "./tool-fixture";

test("write approvals distinguish creation from replacement using the actual old file", async () => {
	const f = await toolFixture();
	try {
		const target = path.join(f.cwd, "notes.txt");
		await f.run("write", { path: target, content: "first\n" });
		expect(formatApproval(f.requests[0]!)).toContain("创建新文件");
		await f.run("write", { path: target, content: "second\n" });
		const approval = formatApproval(f.requests[1]!);
		expect(approval).toContain("覆盖现有文件");
		expect(approval).toContain("-first");
		expect(approval).toContain("+second");
		expect(approval).toContain("新增 1 行 · 删除 1 行");
		expect(await Bun.file(target).text()).toBe("second\n");
	} finally {
		await f.close();
	}
}, 30_000);

for (const ending of ["\n", "\r\n"])
	test(`long edit previews retain the actual late change with ${JSON.stringify(ending)} endings`, async () => {
		const f = await toolFixture();
		try {
			const prefix = `unchanged context${ending}`.repeat(100);
			const before = `${prefix}old${ending}`;
			const after = `${prefix}new${ending}`;
			const target = path.join(f.cwd, "example.txt");
			await Bun.write(target, before);
			await f.run("edit", { path: target, old_string: before, new_string: after });
			const approval = formatApproval(f.requests[0]!);
			expect(approval).toContain("-old");
			expect(approval).toContain("+new");
			expect(approval).toContain("行号相对于片段");
			expect(await Bun.file(target).text()).toBe(after);
		} finally {
			await f.close();
		}
	}, 30_000);

test("a file changed during approval is preserved instead of applying a stale overwrite", async () => {
	const f = await toolFixture();
	try {
		const target = path.join(f.cwd, "contested.txt");
		await Bun.write(target, "original");
		f.policy.setApprover(async () => {
			await Bun.write(target, "external change");
			return "once";
		});
		await expect(f.run("write", { path: target, content: "proposed" })).rejects.toThrow(/预览后发生变化/);
		expect(await Bun.file(target).text()).toBe("external change");
		expect(f.runtime.journal.list()).toEqual([]);
	} finally {
		await f.close();
	}
}, 30_000);

test("diff coverage and counts stay visible when a preview is bounded on either path style", () => {
	for (const target of ["C:\\项目\\file.txt", "/Users/example/项目/file.txt"]) {
		const preview = changePreview(target, null, "new line\n".repeat(200));
		const request: Request = { tool: "write", kind: "write", target, parameters: preview };
		const summary = formatApproval(request, true);
		expect(summary).toContain("新增 200 行");
		expect(summary).toContain("仅展示部分差异");
		expect(formatApproval(request)).not.toContain("beforeHash");
	}
});

test("BOM and CRLF writes approve only the changed line and restore exact bytes", async () => {
	const f = await toolFixture();
	try {
		const target = path.join(f.cwd, "conventions.txt");
		const original = "\uFEFFfirst\r\nsecond\r\n";
		await Bun.write(target, original);
		await f.run("write", { path: target, content: "updated\nsecond\n" });
		expect(await fs.readFile(target, "utf8")).toBe("\uFEFFupdated\r\nsecond\r\n");
		const approval = formatApproval(f.requests[0]!);
		expect(approval).toContain("新增 1 行 · 删除 1 行");
		expect(approval).toContain("-\uFEFFfirst");
		expect(approval).toContain("+\uFEFFupdated");
		await f.runtime.journal.restore(f.runtime.journal.latestTurn()[0]!.id);
		expect(await fs.readFile(target, "utf8")).toBe(original);
	} finally {
		await f.close();
	}
}, 30_000);
test("BOM-only external changes during approval reject stale writes", async () => {
	const f = await toolFixture();
	try {
		const target = path.join(f.cwd, "bom-conflict.txt");
		await Bun.write(target, "first\r\nsecond\r\n");
		f.policy.setApprover(async () => {
			await Bun.write(target, "\uFEFFfirst\r\nsecond\r\n");
			return "once";
		});
		await expect(f.run("write", { path: target, content: "updated\nsecond\n" })).rejects.toThrow(/预览后发生变化/);
		expect(await fs.readFile(target, "utf8")).toBe("\uFEFFfirst\r\nsecond\r\n");
		expect(f.runtime.journal.list()).toEqual([]);
	} finally {
		await f.close();
	}
}, 30_000);
test("CRLF normalization enforces the final one MB write limit before approval", async () => {
	const f = await toolFixture();
	try {
		const target = path.join(f.cwd, "limit.txt");
		await Bun.write(target, "old\r\n");
		await expect(f.run("write", { path: target, content: "a\n".repeat(400_000) })).rejects.toThrow(/1MB/);
		expect(f.requests).toEqual([]);
		expect(await fs.readFile(target, "utf8")).toBe("old\r\n");
	} finally {
		await f.close();
	}
}, 30_000);
