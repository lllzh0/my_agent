import { beforeAll, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { Supervisor, type Job } from "../src/processes/supervisor";
import { quoteCommand } from "../src/processes/shell";
import { formatCommandOutput, formatCommandResult } from "../src/tui/command-result";
import { toolFixture } from "./tool-fixture";

beforeAll(() => initTheme());

function textResult(output: AgentToolResult<unknown>): string {
	return output.content
		.filter(item => item.type === "text")
		.map(item => item.text)
		.join("\n");
}

const failed: Job = {
	id: "test-job",
	command: "test",
	cwd: "/work/项目",
	status: "failed",
	exitCode: 7,
	startedAt: "2026-10-28T00:00:00.000Z",
	endedAt: "2026-10-28T00:00:02.500Z",
	log: `build started\n${"progress\n".repeat(150)}FINAL_ASSERTION_FAILURE`,
	dropped: 0,
};

test("collapsed output retains late failures and expanded output reveals more context without mutating logs", () => {
	const job = {
		...failed,
		log: `build started\n${"progress\n".repeat(5)}early diagnostic\n${"progress\n".repeat(145)}FINAL_ASSERTION_FAILURE`,
	};
	const original = structuredClone(job);
	const collapsed = formatCommandResult(job);
	expect(collapsed).toContain("FINAL_ASSERTION_FAILURE");
	expect(collapsed).toContain("build started");
	expect(collapsed).toContain("用时 2.5s");
	expect(collapsed).not.toContain("early diagnostic");
	expect(formatCommandResult(job, true)).toContain("early diagnostic");
	expect(job).toEqual(original);
});

test("huge Unicode lines preserve both ends within byte budgets and disclose omissions", () => {
	const output = formatCommandOutput(`HEAD ${"中文😀".repeat(10_000)} FINAL_FAILURE`);
	expect(output).toContain("HEAD");
	expect(output).toContain("FINAL_FAILURE");
	expect(output).toContain("预览已截断");
	expect(output.isWellFormed()).toBe(true);
	expect(output).not.toContain("\ufffd");
	expect(Buffer.byteLength(output)).toBeLessThan(2_300);
});

test("both path styles keep command context while logs strip terminal controls and redact credentials", () => {
	for (const cwd of ["C:\\项目\\work", "/Users/example/项目/work"]) {
		const output = formatCommandResult({
			...failed,
			cwd,
			command: "run --token sk-\x1b[31mFAKE_NOT_A_SECRET",
			log: "\x1b[2Jfirst\r\nsecond\rlast\tvalue\x00\x1b]0;hostile-title\x07 Bearer FAKE_ONLY",
		});
		expect(output).toContain(cwd);
		expect(output).toContain("first\nsecond\nlast");
		expect(output).not.toMatch(/[\x00\x07\x1b\r\t]/);
		expect(output).not.toContain("hostile-title");
		expect(output).not.toContain("FAKE_NOT_A_SECRET");
		expect(output).not.toContain("FAKE_ONLY");
	}
});

test("missing and invalid timing never manufactures duration or a successful exit", () => {
	for (const job of [
		{ ...failed, status: "running" as const, exitCode: undefined, endedAt: undefined },
		{ ...failed, status: "cancelled" as const, exitCode: null, endedAt: "invalid" },
		{ ...failed, status: "interrupted" as const, exitCode: undefined, endedAt: "2020-01-01" },
	]) {
		const output = formatCommandResult(job);
		expect(output).toContain("退出码 未取得");
		expect(output).not.toContain("用时");
		expect(output).not.toContain("NaN");
	}
	const page = formatCommandResult({ ...failed, dropped: 500 }, false, { cursor: 700, truncated: true });
	expect(page).toContain("日志游标 700");
	expect(page).toContain("请求起点已淘汰");
	expect(page).toContain("无法通过展开恢复");
});

test("real foreground, background log and stop tools share display without changing model-facing contracts", async () => {
	const f = await toolFixture();
	// Exercise real shell/lifecycle with a harness backend, not OS isolation acceptance.
	const jobs = new Supervisor(f.runtime.stateDir, f.cwd, f.policy, {
		wrap: async command => command,
		close: async () => {},
	});
	f.state.jobs = jobs;
	try {
		const command = quoteCommand([
			process.execPath,
			"--no-env-file",
			"-e",
			"console.log('START'); console.log('progress\\n'.repeat(30)); console.error('FINAL_FAILURE'); process.exit(7)",
		]);
		const output = await f.run("bash", { command });
		const job = JSON.parse(textResult(output)) as Job;
		expect(job.exitCode).toBe(7);
		const bash = f.tools.find(tool => tool.name === "bash")!;
		for (const width of [24, 80]) {
			const rows = bash.renderResult!(output, { expanded: false, isPartial: false }, theme).render(width);
			expect(rows.map(row => Bun.stripANSI(row)).join("\n")).toContain("FINAL_FAILURE");
			expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
		}
		const cursor = job.log.indexOf("FINAL_FAILURE");
		const page = await f.run("job_output", { id: job.id, cursor });
		expect(JSON.parse(textResult(page))).toEqual(jobs.output(job.id, cursor));
		const read = f.tools.find(tool => tool.name === "job_output")!;
		const display = read.renderResult!(page, { expanded: false, isPartial: false }, theme).render(100).join("\n");
		expect(display).toContain("FINAL_FAILURE");
		expect(display.slice(display.indexOf("日志游标"))).not.toContain("START");
		expect(display).toContain("日志游标");
		const waiting = await f.run("bash", {
			command: quoteCommand([process.execPath, "--no-env-file", "-e", "setInterval(()=>{},1000)"]),
			background: true,
		});
		const pending = JSON.parse(textResult(waiting)) as Job;
		const stopped = await f.run("job_stop", { id: pending.id });
		expect(JSON.parse(textResult(stopped))).toEqual(jobs.list());
		const stop = f.tools.find(tool => tool.name === "job_stop")!;
		expect(
			stop.renderResult!(stopped, { expanded: false, isPartial: false }, theme).render(100).join("\n"),
		).toContain("已取消");
		const fallback = bash.renderResult!(
			{ content: [{ type: "text", text: "\x1b[2JFAIL\tcheck" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
		)
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(fallback)).toContain("FAIL");
		expect(fallback).not.toContain("\t");
	} finally {
		await jobs.close();
		await f.close();
	}
}, 30_000);
