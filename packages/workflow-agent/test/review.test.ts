import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fixture } from "./helpers";

async function init(cwd: string): Promise<void> {
	for (const args of [
		["init", "-b", "main"],
		["config", "user.name", "Review Fixture"],
		["config", "user.email", "review@example.test"],
		["add", "."],
		["commit", "--allow-empty", "-m", "fixture"],
	]) {
		const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code) throw new Error(stderr);
	}
}

async function run(home: string, cwd: string, cancel = false, recovery?: "new" | "close") {
	const output = path.join(home, "review-result.json");
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "review-worker.ts"),
			JSON.stringify({ home, cwd, output, cancel, recovery }),
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: os.homedir(),
				PRODUCT_TEST_KEY: "fake-local-key",
				PI_CONFIG_DIR: path.relative(os.homedir(), path.join(home, "omp")),
				PI_CODING_AGENT_DIR: path.join(home, "omp/agent"),
				PI_NATIVES_DIR: path.join(home, "natives"),
				TERM: "dumb",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	if (code) throw new Error(stderr);
	return await Bun.file(output).json();
}

test("review sends a frozen diff to a bounded reader and cannot write even if the model requests it", async () => {
	const f = await fixture();
	try {
		await init(f.cwd);
		await Bun.write(path.join(f.cwd, "changed.ts"), "REVIEW_INPUT\n");
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		f.respond(body =>
			body.messages.some(message => message.role === "tool")
				? { text: "[P2] changed.ts:1 observable finding" }
				: { call: { name: "write", arguments: { path: "changed.ts", content: "UNAUTHORIZED_REVIEW_WRITE" } } },
		);
		const result = await run(f.home, f.cwd);
		expect(result.result.output).toContain("observable finding");
		expect(result.result.snapshot.files.map((file: { path: string }) => file.path)).toEqual(["changed.ts"]);
		expect(await fs.readFile(path.join(f.cwd, "changed.ts"), "utf8")).toBe("REVIEW_INPUT\n");
		for (const request of f.requests) {
			expect((request.tools ?? []).every(tool => ["find", "grep", "ls", "read"].includes(tool.function.name))).toBe(
				true,
			);
			expect(JSON.stringify(request.messages)).toContain("REVIEW_INPUT");
		}
		expect(f.requests[0].tools?.map(tool => tool.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
		expect(result.stats.requests).toBe(f.requests.length);
		expect(result.busy).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

test("empty review makes no provider request and repeated tool requests stop at a bounded partial report", async () => {
	const f = await fixture();
	try {
		await init(f.cwd);
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const empty = await run(f.home, f.cwd);
		expect(empty.result.requests).toBe(0);
		expect(f.requests).toHaveLength(0);
		await Bun.write(path.join(f.cwd, "changed.ts"), "kept\n");
		f.respond(body =>
			body.tools?.length
				? { call: { name: "read", arguments: { path: "changed.ts" } } }
				: { text: "PARTIAL_REVIEW_REPORT" },
		);
		const bounded = await run(f.home, f.cwd);
		expect(f.requests.length).toBeLessThanOrEqual(6);
		expect(bounded.result.partial).toBe(true);
		expect(bounded.result.output).toContain("PARTIAL_REVIEW_REPORT");
		expect(bounded.stats.requests).toBe(f.requests.length);
	} finally {
		await f.close();
	}
}, 30_000);

test("cancelled streaming review releases its busy state and keeps request accounting", async () => {
	const f = await fixture();
	try {
		await init(f.cwd);
		await Bun.write(path.join(f.cwd, "changed.ts"), "STALL_CHILD\n");
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		f.stallChild();
		const cancelled = await run(f.home, f.cwd, true);
		expect(cancelled.result.cancelled).toBe(true);
		expect(cancelled.result.partial).toBe(true);
		expect(cancelled.busy).toBe(false);
		expect(cancelled.blocked).toEqual(Array(4).fill("blocked"));
		expect(cancelled.stats.requests).toBe(1);
		expect(f.requests).toHaveLength(1);
		expect(await Bun.file(path.join(f.cwd, "changed.ts")).text()).toBe("STALL_CHILD\n");
	} finally {
		await f.close();
	}
}, 30_000);

test("diff command opens project changes without contacting a model", async () => {
	const f = await fixture();
	try {
		await init(f.cwd);
		await Bun.write(path.join(f.cwd, "changed.ts"), "DIFF_COMMAND_INPUT\n");
		const run = await f.run({ action: "commands", commands: ["/diff"] });
		expect(run.code).toBe(0);
		expect(JSON.stringify(run.result.displays)).toContain("DIFF_COMMAND_INPUT");
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("review command uses the host reader and reports its usage separately", async () => {
	const f = await fixture();
	try {
		await init(f.cwd);
		await Bun.write(path.join(f.cwd, "changed.ts"), "COMMAND_REVIEW_BODY\n");
		f.respond(() => ({ text: "COMMAND_REVIEW_FINDING" }));
		const result = await f.run({ action: "commands", commands: ["/review", "/usage"] });
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.stringify(result.result.displays)).toContain("COMMAND_REVIEW_FINDING");
		const usage = result.result.displays.find((item: { title: string }) => item.title === "本地用量");
		expect(JSON.parse(usage.text).codeReview.requests).toBe(f.requests.length);
		expect(f.requests.length).toBeGreaterThan(0);
		expect(await Bun.file(result.result.sessionFile).exists()).toBe(true);
		const afterRestart = await f.run({ resume: result.result.sessionFile, action: "commands", commands: ["/usage"] });
		expect(afterRestart.code, afterRestart.stderr).toBe(0);
		const restoredUsage = afterRestart.result.displays.find((item: { title: string }) => item.title === "本地用量");
		expect(JSON.parse(restoredUsage.text).codeReview).toEqual(JSON.parse(usage.text).codeReview);
		expect(afterRestart.result.messages).toEqual([]);
		expect(f.requests).toHaveLength(JSON.parse(usage.text).codeReview.requests);
	} finally {
		await f.close();
	}
}, 30_000);

for (const recovery of ["new", "close"] as const)
	test(`review-only session remains recoverable after ${recovery} without a main model turn`, async () => {
		const f = await fixture();
		try {
			await init(f.cwd);
			await Bun.write(path.join(f.cwd, "changed.ts"), "REVIEW_ONLY_PERSISTENCE\n");
			await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
			f.respond(() => ({ text: "PERSISTED_REVIEW_FINDING" }));
			const output = await run(f.home, f.cwd, false, recovery);
			expect(output.stats.reviews).toBe(1);
			expect(output.result.output).toContain("PERSISTED_REVIEW_FINDING");
			expect(output.recovery.rootMessages).toEqual([]);
			expect(output.recovery.fileBefore).toBe(true);
			expect(output.recovery.error).toBe("");
			expect(output.recovery.restoredId).toBe(output.recovery.source.id);
			expect(output.recovery.restoredStats).toEqual(output.stats);
			expect(output.recovery.restoredMessages).toEqual([]);
			if (recovery === "new") {
				expect(output.recovery.newId).not.toBe(output.recovery.source.id);
				expect(output.recovery.newStats.reviews).toBe(0);
				expect(output.recovery.listIds).toContain(output.recovery.source.id);
			}
			const artifacts = await fs.readdir(path.join(output.recovery.source.stateDir, "reviews"));
			expect(artifacts.some(file => file.endsWith(".json"))).toBe(true);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.close();
		}
	}, 30_000);
