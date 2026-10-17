import { expect, test } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { fixture } from "./helpers";

interface GoalFixture {
	home: string;
	cwd: string;
	root: string;
	config: unknown;
}

async function run(f: GoalFixture, scenario: string, resume?: string) {
	await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
	const resultFile = path.join(f.root, `goal-${scenario}.json`);
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "goal-worker.ts"),
			JSON.stringify({ home: f.home, cwd: f.cwd, resultFile, scenario, resume }),
		],
		{
			cwd: f.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH,
				HOME: os.homedir(),
				TERM: "dumb",
				PRODUCT_TEST_KEY: "local-goal-key",
				PI_CONFIG_DIR: path.relative(os.homedir(), path.join(f.home, "omp")),
				PI_CODING_AGENT_DIR: path.join(f.home, "omp/agent"),
				PI_NATIVES_DIR: path.join(f.home, "natives"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
			},
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, `${stderr}\n${stdout.slice(-1500)}`).toBe(0);
	return Bun.file(resultFile).json();
}

for (const continuation of [false, true])
	test(`native goal ${continuation ? "automatically continues" : "starts and completes"} with only controlled product tools`, async () => {
		const f = await fixture();
		try {
			f.respond(body => {
				const text = JSON.stringify(body.messages);
				if (body.messages.some(message => message.role === "tool" && String(message.content).includes("Goal:")))
					return { text: "GOAL_FINISHED" };
				if (continuation && !text.includes("Continue active goal.")) {
					return body.messages.some(message => message.role === "tool")
						? { text: "One step finished; continue working." }
						: { call: { name: "read", arguments: { path: "missing.txt" } } };
				}
				return { call: { name: "goal", arguments: { op: "complete" } } };
			});
			const result = await run(f, continuation ? "continue" : "complete");
			expect(result.initial.tools).not.toContain("goal");
			expect(result.tools).not.toContain("goal");
			expect(result.goal).toBeUndefined();
			const first = f.requests[0];
			expect(first.tools?.map(tool => tool.function.name)).toContain("goal");
			expect(first.tools?.map(tool => tool.function.name)).not.toContain("task");
			expect(result.changes).toEqual([]);
			expect(result.userTask).toBe(continuation ? "NEED_CONTINUATION" : "COMPLETE_PRODUCT_GOAL");
			if (continuation)
				expect(
					result.messages.some((message: { customType?: string }) => message.customType === "goal-continuation"),
				).toBe(true);
		} finally {
			await f.close();
		}
	}, 20000);

test("native goal controls preserve product plan boundaries and restart in a paused state", async () => {
	const f = await fixture();
	try {
		const result = await run(f, "controls");
		expect(result.details.active.tools).toContain("goal");
		expect(result.details.paused.goal.goal.status).toBe("paused");
		expect(result.details.paused.goal.goal.tokenBudget).toBe(5000);
		expect(result.details.paused.tools).not.toContain("goal");
		expect(result.details.planWhileActive).toBe("execute");
		expect(result.details.planBlocked.goal.status).toBe("paused");
		expect(result.details.resumed.tools).toContain("goal");
		expect(result.details.denied.handled).toBe(true);
		expect(result.goal.goal.objective).toBe("PRODUCT_GOAL");
		expect(f.requests).toHaveLength(1);
		const restored = await run(f, "restore", result.sessionFile);
		expect(restored.initial.goal.goal.status).toBe("paused");
		expect(restored.initial.goal.goal.tokenBudget).toBe(5000);
		// OMP keeps its inspection tool with a restored paused goal. It must
		// not start a model turn until the user explicitly resumes.
		expect(f.requests).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 20000);

for (const scenario of ["continue-constraints", "resume-constraints"])
	test(`goal ${scenario} preserves newer human restrictions in the approval context`, async () => {
		const f = await fixture();
		try {
			f.respond(body => {
				const latest = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content);
				if (body.messages.some(message => message.role === "tool" && String(message.content).includes("Goal:")))
					return { text: "DONE" };
				if (latest.includes("Continue active goal."))
					return { call: { name: "goal", arguments: { op: "complete" } } };
				if (latest.includes("STRICT_HUMAN_CONSTRAINT")) return { text: "Constraint acknowledged." };
				return body.messages.some(message => message.role === "tool")
					? { text: "One step finished." }
					: { call: { name: "read", arguments: { path: "missing.txt" } } };
			});
			const result = await run(f, scenario);
			expect(result.userTask).toBe("STRICT_HUMAN_CONSTRAINT: explain only; do not run external actions.");
			expect(
				result.messages.some((message: { customType?: string }) => message.customType === "goal-continuation"),
			).toBe(true);
			expect(result.goal).toBeUndefined();
		} finally {
			await f.close();
		}
	}, 20000);

test("goal input in the one-shot CLI is refused without sending its text to the model", async () => {
	const f = await fixture();
	try {
		const result = await f.cli([], "/goal set DO_NOT_SEND");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("交互终端");
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 20000);

test("closing while native goal exit restores tools cannot strand the product input loop", async () => {
	const f = await fixture();
	try {
		const result = await run(f, "shutdown-wait");
		expect(result.details.inputLoopClosed).toBe(true);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 20000);

for (const method of ["resume-auto", "resume-menu-auto"])
	test(`human goal ${method} restores the objective used to automatically approve a matching file edit`, async () => {
		const f = await fixture();
		try {
			const saved = await run(f, "controls");
			f.reviewReply("allow");
			f.respond(body => {
				if (!body.tools?.length) return;
				const results = body.messages.filter(message => message.role === "tool");
				if (results.some(message => String(message.content).includes("Goal:"))) return { text: "DONE" };
				if (results.length) return { call: { name: "goal", arguments: { op: "complete" } } };
				return { call: { name: "write", arguments: { path: "resumed-goal.txt", content: "RESUMED_GOAL_OK" } } };
			});
			const result = await run(f, method, saved.sessionFile);
			expect(result.userTask).toBe("PRODUCT_GOAL");
			expect(result.reviewUsage.requests).toBe(1);
			expect(await Bun.file(path.join(f.cwd, "resumed-goal.txt")).text()).toBe("RESUMED_GOAL_OK");
			expect(result.changes).toHaveLength(1);
		} finally {
			await f.close();
		}
	}, 20000);

test("the model can complete a goal but cannot replace or drop its human objective", async () => {
	const f = await fixture();
	try {
		f.respond(body => {
			const results = body.messages.filter(message => message.role === "tool");
			if (results.length === 0)
				return {
					call: { name: "goal", arguments: { op: "create", objective: "MODEL_REPLACEMENT", token_budget: 1 } },
				};
			if (results.length === 1) return { call: { name: "goal", arguments: { op: "drop" } } };
			if (results.length === 2) return { call: { name: "goal", arguments: { op: "complete" } } };
			return { text: "DONE" };
		});
		const result = await run(f, "complete");
		const results = result.messages.filter(
			(message: { role: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "goal",
		);
		expect(results.map((message: { isError?: boolean }) => message.isError === true)).toEqual([true, true, false]);
		expect(result.userTask).toBe("COMPLETE_PRODUCT_GOAL");
		expect(result.goal).toBeUndefined();
	} finally {
		await f.close();
	}
}, 20000);
