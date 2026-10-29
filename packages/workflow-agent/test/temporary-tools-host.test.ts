import { expect, test } from "bun:test";
import * as path from "node:path";
import { fixture, HOST_TEST_TIMEOUT } from "./helpers";

test(
	"a one-call tool approval executes its requested write without exposing write to another model call",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.disabled = ["tool:write"];
			f.callTools([
				{
					name: "request_tool",
					arguments: {
						tool: "write",
						reason: "Save the requested note",
						arguments: { path: "once.txt", content: "APPROVED_ONCE" },
					},
				},
				{ name: "write", arguments: { path: "unapproved.txt", content: "MUST_NOT_WRITE" } },
			]);
			const run = await f.run({ approve: true, approveTool: "once" });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "once.txt")).text()).toBe("APPROVED_ONCE");
			expect(await Bun.file(path.join(f.cwd, "unapproved.txt")).exists()).toBe(false);
			for (const request of f.requests)
				expect(request.tools?.some(tool => tool.function.name === "write")).toBe(false);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"a run grant exposes the tool on later requests, keeps config unchanged and expires on cold resume",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.disabled = ["tool:write"];
			f.callTools([
				{
					name: "request_tool",
					arguments: {
						tool: "write",
						reason: "Save project notes",
						arguments: { path: "first.txt", content: "FIRST" },
					},
				},
				{ name: "write", arguments: { path: "second.txt", content: "SECOND" } },
			]);
			const run = await f.run({ approve: true, approveTool: "run" });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "second.txt")).text()).toBe("SECOND");
			expect(f.requests[0].tools?.some(tool => tool.function.name === "write")).toBe(false);
			expect(f.requests[1].tools?.some(tool => tool.function.name === "write")).toBe(true);
			expect((await Bun.file(path.join(f.home, "config.json")).json()).resources.disabled).toEqual(["tool:write"]);
			const resumed = await f.run({ resume: run.result.sessionFile, action: "commands", commands: ["/tools list"] });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.tools).not.toContain("write");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT * 2,
);

test(
	"full operation permission cannot approve a new tool capability without a human capability callback",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.disabled = ["tool:write"];
			f.callTool("request_tool", {
				tool: "write",
				reason: "Request a disabled tool",
				arguments: { path: "blocked.txt", content: "MUST_NOT_WRITE" },
			});
			const run = await f.run({
				action: "commands",
				commands: ["/permissions full"],
				promptAfterCommands: "Try the disabled tool",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "blocked.txt")).exists()).toBe(false);
			expect(run.result.tools).not.toContain("write");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"a run grant stays with the same Agent across new conversations without crossing cold starts",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.disabled = ["tool:write"];
			f.respond(request => {
				if (request.messages.some(message => message.role === "tool")) return { text: "DONE" };
				const task = JSON.stringify(request.messages.findLast(message => message.role === "user")?.content);
				return task.includes("first conversation")
					? {
							call: {
								name: "request_tool",
								arguments: {
									tool: "write",
									reason: "Save notes",
									arguments: { path: "before-new.txt", content: "BEFORE" },
								},
							},
						}
					: { call: { name: "write", arguments: { path: "after-new.txt", content: "AFTER" } } };
			});
			const run = await f.run({
				approve: true,
				approveTool: "run",
				promptsBefore: ["first conversation"],
				action: "commands",
				commands: ["/new"],
				promptAfterCommands: "second conversation",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "after-new.txt")).text()).toBe("AFTER");
			expect(f.requests.at(-1)?.tools?.some(tool => tool.function.name === "write")).toBe(true);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"a model-origin tools management command cannot turn on a disabled tool",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.disabled = ["tool:write"];
			const run = await f.run({ action: "commands", commands: ["/tools allow write"], inputSource: "extension" });
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.tools).not.toContain("write");
			expect(run.result.notifications.some((text: string) => /用户主动调用/.test(text))).toBe(true);
			expect(f.requests).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"a persistent off command also revokes a previous temporary run grant",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.disabled = ["tool:write"];
			f.respond(request => {
				if (request.messages.some(message => message.role === "tool")) return { text: "DONE" };
				return {
					call: {
						name: "request_tool",
						arguments: {
							tool: "write",
							reason: "One task needs write",
							arguments: { path: "before-off.txt", content: "BEFORE" },
						},
					},
				};
			});
			const run = await f.run({
				approve: true,
				approveTool: "run",
				promptsBefore: ["grant write"],
				action: "commands",
				commands: ["/resources off tool:write"],
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "before-off.txt")).text()).toBe("BEFORE");
			expect(run.result.tools).not.toContain("write");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);
