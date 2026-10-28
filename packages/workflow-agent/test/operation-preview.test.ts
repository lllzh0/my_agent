import { expect, test } from "bun:test";
import { chooseApproval, formatApproval, formatCommandResult } from "../src/tui/operation-preview";
import type { Job } from "../src/processes/supervisor";

test("edit approval shows removed and added lines without turning the preview into a grant", () => {
	const request = {
		tool: "edit",
		kind: "write" as const,
		target: "/work/example.ts",
		parameters: { before: "old\n", after: "new\n", replaceAll: true, editsHash: "unchanged-binding" },
	};
	const original = structuredClone(request);
	const text = formatApproval(request);
	expect(text).toContain("-old");
	expect(text).toContain("+new");
	expect(text).toContain("全部匹配");
	expect(text).not.toContain("editsHash");
	expect(request).toEqual(original);
});

test("long replacement and new-file previews disclose incomplete coverage", () => {
	const edit = formatApproval({
		tool: "edit",
		kind: "write",
		target: "file",
		parameters: {
			before: "before",
			after: "after",
			previewTruncated: true,
		},
	});
	expect(edit).toContain("仅展示部分");
	const write = formatApproval({
		tool: "write",
		kind: "write",
		target: "new.txt",
		parameters: {
			preview: "line\n".repeat(200),
			previewTruncated: true,
		},
	});
	expect(write).toContain("不代表完整文件差异");
	expect(write).toContain("预览已截断");
	expect(write.split("\n").length).toBeLessThanOrEqual(101);
});

test("collapsed command output exposes nonzero exit and bounded logs while preserving the result", () => {
	const job: Job = {
		id: "job-1",
		command: "test",
		cwd: "/work",
		status: "failed",
		exitCode: 2,
		startedAt: "2026-10-28",
		log: "assertion failed\n".repeat(20),
		dropped: 100,
	};
	const original = structuredClone(job);
	const collapsed = formatCommandResult(job);
	expect(collapsed).toContain("失败 · 退出码 2");
	expect(collapsed).toContain("assertion failed");
	expect(collapsed).toContain("预览已截断");
	expect(collapsed).toContain("较早输出已淘汰");
	expect(formatCommandResult(job, true)).not.toContain("预览已截断");
	expect(job).toEqual(original);
});

test("running and cancelled commands never manufacture a successful exit code", () => {
	const job: Job = {
		id: "pending",
		command: "wait",
		cwd: "/work",
		status: "running",
		startedAt: "now",
		log: "",
		dropped: 0,
	};
	expect(formatCommandResult(job)).toContain("运行中 · 退出码 未取得");
	expect(formatCommandResult({ ...job, status: "cancelled", exitCode: null })).toContain("已取消 · 退出码 未取得");
});

test("closing read-only details returns to approval and cancellation denies", async () => {
	const answers = ["查看修改详情（只读）", undefined];
	let inspected = 0;
	let prompts = 0;
	const decision = await chooseApproval(
		{ tool: "edit", kind: "write", target: "file", parameters: { before: "a", after: "b" } },
		async () => {
			prompts++;
			return answers.shift();
		},
		async body => {
			inspected++;
			expect(body).toContain("-a");
			expect(body).toContain("+b");
		},
	);
	expect(inspected).toBe(1);
	expect(prompts).toBe(2);
	expect(decision).toBe("deny");
});
