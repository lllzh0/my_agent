import { expect, test } from "bun:test";
import * as path from "node:path";
import { fixture } from "./helpers";

for (const scenario of [
	{ name: "full access submits an absolute path before the instruction", mode: "full", leading: true },
	{ name: "full access submits an absolute path after the instruction", mode: "full", leading: false },
	{ name: "auto access receives the current task when it starts with an absolute path", mode: "auto", leading: true },
] as const)
	test(
		scenario.name,
		async () => {
			const f = await fixture();
			try {
				const target = path.join(scenario.mode === "full" ? f.root : f.cwd, "手写卡.txt");
				await Bun.write(target, "ORIGINAL\n");
				const input = scenario.leading
					? `${target} 给这个文件末尾增加一行test`
					: `给这个文件末尾增加一行test ${target}`;
				f.callTools([
					{ name: "read", arguments: { path: target } },
					{ name: "edit", arguments: { path: target, old_string: "ORIGINAL\n", new_string: "ORIGINAL\ntest\n" } },
				]);
				const run = await f.run({
					action: "submit",
					commands: [`/permissions ${scenario.mode}`],
					command: input,
				});
				expect(run.code, run.stderr).toBe(0);
				expect(run.result.actionResult.handled).not.toBe(true);
				expect(await Bun.file(target).text()).toBe("ORIGINAL\ntest\n");
				expect(f.requests[0].messages.find(message => message.role === "user")?.content).toContainEqual({
					type: "text",
					text: input,
				});
				expect(run.result.userTask).toBe(input);
				expect(run.result.changes).toHaveLength(1);
			} finally {
				await f.close();
			}
		},
		30000,
	);

test("a root-level filename is a task rather than an unknown command", async () => {
	const f = await fixture();
	try {
		const input = "/手写卡.txt 给这个文件末尾增加一行test";
		const run = await f.run({ action: "input", command: input });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult.handled).not.toBe(true);
		expect(run.result.userTask).toBe(input);
	} finally {
		await f.close();
	}
}, 30000);

test("unadapted colon-form commands remain blocked when their arguments contain paths", async () => {
	const f = await fixture();
	try {
		const commands = ["/ssh:host/path", "/cd:/private/tmp", "/mcp: reload", "/skill:missing/path"];
		const run = await f.run({ action: "commands", commands });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult).toEqual(commands.map(() => ({ handled: true })));
		expect(run.result.userTask).toBe("");
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30000);
