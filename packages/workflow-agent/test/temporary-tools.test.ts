import { expect, test } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { Type } from "@oh-my-pi/omptype/typebox";
import * as path from "node:path";
import { TemporaryTools, type ToolAccessDecision, type ToolAccessRequest } from "../src/runtime/temporary-tools";
import { Supervisor, type Job } from "../src/processes/supervisor";
import { quoteCommand } from "../src/processes/shell";
import { toolFixture } from "./tool-fixture";

const ctx = {} as ExtensionContext;

function writeRequest(target: string, content = "approved"): ToolAccessRequest {
	return { tool: "write", reason: "保存已确认的修改", arguments: { path: target, content } };
}

test("once writes only the approved file and the next write still needs capability approval", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const access = f.state.toolAccess!;
		let approvals = 0;
		access.setApprover(async () => (++approvals === 1 ? "once" : "deny"));
		const first = path.join(f.cwd, "first.txt");
		const second = path.join(f.cwd, "second.txt");
		await access.execute("first", writeRequest(first), undefined, undefined, ctx);
		expect(await Bun.file(first).text()).toBe("approved");
		expect(access.allows("write")).toBe(false);
		await expect(access.execute("second", writeRequest(second), undefined, undefined, ctx)).rejects.toThrow();
		expect(await Bun.file(second).exists()).toBe(false);
		expect(approvals).toBe(2);
	} finally {
		await f.close();
	}
}, 30_000);

test("run unlocks only the approved tool until revoked and a fresh controller has no grant", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write", "tool:edit"];
		const access = f.state.toolAccess!;
		let approvals = 0;
		access.setApprover(async () => {
			approvals++;
			return "run";
		});
		await access.execute("first", writeRequest(path.join(f.cwd, "first.txt")), undefined, undefined, ctx);
		await access.execute("second", writeRequest(path.join(f.cwd, "second.txt")), undefined, undefined, ctx);
		expect(await Bun.file(path.join(f.cwd, "second.txt")).text()).toBe("approved");
		expect(approvals).toBe(1);
		expect(access.allows("edit")).toBe(false);
		expect(access.list().find(tool => tool.name === "write")).toMatchObject({ enabled: false, temporary: true });
		access.revoke("write");
		access.setApprover(async () => "deny");
		await expect(
			access.execute("revoked", writeRequest(path.join(f.cwd, "revoked.txt")), undefined, undefined, ctx),
		).rejects.toThrow();
		expect(await Bun.file(path.join(f.cwd, "revoked.txt")).exists()).toBe(false);
		const fresh = new TemporaryTools(f.state, f.tools);
		expect(fresh.allows("write")).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

test("missing write content is rejected before capability approval and has no file effect", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const access = f.state.toolAccess!;
		let approvals = 0;
		access.setApprover(async () => {
			approvals++;
			return "once";
		});
		const target = path.join(f.cwd, "invalid.txt");
		await expect(
			access.execute(
				"invalid",
				{ tool: "write", reason: "测试缺失参数", arguments: { path: target } },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/content/);
		expect(approvals).toBe(0);
		expect(await Bun.file(target).exists()).toBe(false);
	} finally {
		await f.close();
	}
});

for (const mode of ["manual", "auto", "full"] as const)
	test(`${mode} operation approval cannot implicitly enable a disabled capability`, async () => {
		const f = await toolFixture();
		try {
			f.state.config.resources.disabled = ["tool:write"];
			f.policy.setApprovalMode(mode);
			const target = path.join(f.cwd, "implicit.txt");
			await expect(
				f.state.toolAccess!.execute("implicit", writeRequest(target), undefined, undefined, ctx),
			).rejects.toThrow();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(f.requests).toEqual([]);
		} finally {
			await f.close();
		}
	});

test("an enabled baseline tool keeps its original operation approval without a second capability prompt", async () => {
	const f = await toolFixture();
	try {
		const access = f.state.toolAccess!;
		access.setApprover(async () => "deny");
		const target = path.join(f.cwd, "baseline.txt");
		await access.execute("baseline", writeRequest(target), undefined, undefined, ctx);
		expect(await Bun.file(target).text()).toBe("approved");
		expect(f.requests.map(request => request.tool)).toEqual(["write"]);
		access.grant("write");
		f.policy.setApprover(async () => "deny");
		await expect(
			access.execute("operation-denied", writeRequest(target, "denied"), undefined, undefined, ctx),
		).rejects.toThrow();
		expect(await Bun.file(target).text()).toBe("approved");
	} finally {
		await f.close();
	}
}, 30_000);

test("caller and approval-preview mutations cannot change the copied write that executes", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const access = f.state.toolAccess!;
		const entered = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<ToolAccessDecision>();
		const target = path.join(f.cwd, "snapshot.txt");
		const unexpected = path.join(f.cwd, "unexpected.txt");
		const input = writeRequest(target);
		access.setApprover(async request => {
			request.arguments.content = "preview mutation";
			request.arguments.path = unexpected;
			entered.resolve();
			return decision.promise;
		});
		const executing = access.execute("snapshot", input, undefined, undefined, ctx);
		await entered.promise;
		input.arguments.content = "caller mutation";
		input.arguments.path = unexpected;
		input.tool = "edit";
		decision.resolve("once");
		await executing;
		expect(await Bun.file(target).text()).toBe("approved");
		expect(await Bun.file(unexpected).exists()).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

for (const invalidation of ["cancel", "revoke", "clear", "close", "policy"] as const)
	test(`${invalidation} while awaiting approval makes a late run decision ineffective`, async () => {
		const f = await toolFixture();
		try {
			f.state.config.resources.disabled = ["tool:write"];
			const access = f.state.toolAccess!;
			const entered = Promise.withResolvers<void>();
			const decision = Promise.withResolvers<ToolAccessDecision>();
			const controller = new AbortController();
			access.setApprover(async () => {
				entered.resolve();
				return decision.promise;
			});
			const target = path.join(f.cwd, "stale.txt");
			const executing = access.execute("stale", writeRequest(target), controller.signal, undefined, ctx);
			const rejected = executing.catch((error: unknown) => error);
			await entered.promise;
			if (invalidation === "cancel") controller.abort();
			else if (invalidation === "revoke") access.revoke("write");
			else if (invalidation === "clear") access.clearJobs();
			else if (invalidation === "close") access.close();
			else f.policy.setApprovalMode("full");
			decision.resolve("run");
			expect(await rejected).toBeInstanceOf(Error);
			expect(await Bun.file(target).exists()).toBe(false);
			expect(access.allows("write")).toBe(false);
		} finally {
			await f.close();
		}
	});

test("concurrent once requests serialize the human entry and never share an approval", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const access = f.state.toolAccess!;
		const entered = Promise.withResolvers<void>();
		const firstDecision = Promise.withResolvers<ToolAccessDecision>();
		let approvals = 0;
		access.setApprover(async () => {
			approvals++;
			if (approvals === 1) {
				entered.resolve();
				return firstDecision.promise;
			}
			return "deny";
		});
		const firstTarget = path.join(f.cwd, "queued-first.txt");
		const secondTarget = path.join(f.cwd, "queued-second.txt");
		const first = access.execute("first", writeRequest(firstTarget), undefined, undefined, ctx);
		await entered.promise;
		const second = access.execute("second", writeRequest(secondTarget), undefined, undefined, ctx);
		const denied = second.catch((error: unknown) => error);
		await Bun.sleep(0);
		expect(approvals).toBe(1);
		firstDecision.resolve("once");
		await first;
		expect(await denied).toBeInstanceOf(Error);
		expect(await Bun.file(firstTarget).text()).toBe("approved");
		expect(await Bun.file(secondTarget).exists()).toBe(false);
		expect(approvals).toBe(2);
	} finally {
		await f.close();
	}
}, 30_000);

test("a queued request can reuse run approval but a cancelled queued write cannot execute", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const access = f.state.toolAccess!;
		const entered = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<ToolAccessDecision>();
		let approvals = 0;
		access.setApprover(async () => {
			approvals++;
			entered.resolve();
			return decision.promise;
		});
		const first = access.execute("first", writeRequest(path.join(f.cwd, "run-first.txt")), undefined, undefined, ctx);
		await entered.promise;
		const aborted = new AbortController();
		const cancelledTarget = path.join(f.cwd, "cancelled.txt");
		const cancelled = access.execute("cancelled", writeRequest(cancelledTarget), aborted.signal, undefined, ctx);
		const rejected = cancelled.catch((error: unknown) => error);
		const secondTarget = path.join(f.cwd, "run-second.txt");
		const second = access.execute("second", writeRequest(secondTarget), undefined, undefined, ctx);
		aborted.abort();
		decision.resolve("run");
		await Promise.all([first, second]);
		expect(await rejected).toBeInstanceOf(Error);
		expect(await Bun.file(secondTarget).text()).toBe("approved");
		expect(await Bun.file(cancelledTarget).exists()).toBe(false);
		expect(approvals).toBe(1);
	} finally {
		await f.close();
	}
}, 30_000);

test("cancelling an active prompt keeps the next human entry queued until its old callback settles", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const access = f.state.toolAccess!;
		const entered = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<ToolAccessDecision>();
		let approvals = 0;
		access.setApprover(async () => {
			approvals++;
			if (approvals === 1) {
				entered.resolve();
				return decision.promise;
			}
			return "deny";
		});
		const abort = new AbortController();
		const first = access.execute(
			"cancelled",
			writeRequest(path.join(f.cwd, "late.txt")),
			abort.signal,
			undefined,
			ctx,
		);
		const firstRejected = first.catch((error: unknown) => error);
		await entered.promise;
		abort.abort();
		expect(await firstRejected).toBeInstanceOf(Error);
		const second = access.execute("next", writeRequest(path.join(f.cwd, "next.txt")), undefined, undefined, ctx);
		const secondRejected = second.catch((error: unknown) => error);
		await Bun.sleep(0);
		expect(approvals).toBe(1);
		decision.resolve("run");
		expect(await secondRejected).toBeInstanceOf(Error);
		expect(access.allows("write")).toBe(false);
		expect(await Bun.file(path.join(f.cwd, "late.txt")).exists()).toBe(false);
	} finally {
		await f.close();
	}
});

test("temporary approval retains real directory, plan mode, and network restrictions", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write", "tool:web_fetch"];
		const access = f.state.toolAccess!;
		access.setApprover(async () => "once");
		const outside = path.join(f.cwd, "..", "outside.txt");
		await expect(access.execute("outside", writeRequest(outside), undefined, undefined, ctx)).rejects.toThrow(/范围/);
		expect(await Bun.file(outside).exists()).toBe(false);
		f.policy.mode = "plan";
		const planned = path.join(f.cwd, "planned.txt");
		await expect(access.execute("plan", writeRequest(planned), undefined, undefined, ctx)).rejects.toThrow(
			/计划模式/,
		);
		expect(await Bun.file(planned).exists()).toBe(false);
		f.policy.mode = "execute";
		f.policy.settings.allowNetwork = false;
		await expect(
			access.execute(
				"network",
				{ tool: "web_fetch", reason: "验证禁网", arguments: { url: "https://example.com" } },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/联网/);
	} finally {
		await f.close();
	}
});

test("reserved, unknown, native and unconfigured MCP tools cannot be granted or executed", async () => {
	const f = await toolFixture();
	try {
		const definitions = ["goal", "request_tool", "native_only"].map(name => ({
			name,
			label: name,
			description: "不可通过产品授权入口扩展",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: {} }),
		}));
		const access = new TemporaryTools(f.state, [...f.tools, ...definitions]);
		access.setApprover(async () => "run");
		for (const name of [
			"goal",
			"request_tool",
			"native_only",
			"not_found",
			"mcp_call",
			"mcp_list",
			"import_mcp_source",
		]) {
			expect(() => access.grant(name)).toThrow();
			expect(access.isEnabled(name)).toBe(false);
			await expect(
				access.execute(name, { tool: name, reason: "请求越权", arguments: {} }, undefined, undefined, ctx),
			).rejects.toThrow();
		}
		expect(access.list().map(tool => tool.name)).not.toContain("goal");
		expect(access.list().map(tool => tool.name)).not.toContain("request_tool");
		expect(access.list().map(tool => tool.name)).not.toContain("native_only");
	} finally {
		await f.close();
	}
});

test("MCP approval cannot widen the configured server selection", async () => {
	const f = await toolFixture();
	try {
		f.state.config.mcpServers = { selected: { url: "http://127.0.0.1:9/mcp" } };
		f.state.config.resources.disabled = ["tool:mcp_call"];
		const access = f.state.toolAccess!;
		access.setApprover(async () => "once");
		await expect(
			access.execute(
				"unselected",
				{
					tool: "mcp_call",
					reason: "不能扩大服务",
					arguments: { server: "unselected", tool: "get", arguments: {} },
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/MCP|服务/);
	} finally {
		await f.close();
	}
});

test("light mode and closed controllers expose no usable capability even after a manual grant", async () => {
	const f = await toolFixture();
	try {
		const access = f.state.toolAccess!;
		f.state.light = true;
		expect(access.list()).toEqual([]);
		expect(() => access.grant("write")).toThrow();
		expect(access.allows("read")).toBe(false);
		f.state.light = false;
		access.close();
		expect(access.list()).toEqual([]);
		expect(access.isEnabled("read")).toBe(false);
		expect(() => access.grant("write")).toThrow();
		const target = path.join(f.cwd, "closed.txt");
		await expect(access.execute("closed", writeRequest(target), undefined, undefined, ctx)).rejects.toThrow();
		expect(await Bun.file(target).exists()).toBe(false);
	} finally {
		await f.close();
	}
});

test("a failed once tool execution does not leave a reusable capability", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const tool: ToolDefinition = {
			name: "write",
			label: "write",
			description: "失败路径",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("operation failed");
			},
		};
		const access = new TemporaryTools(f.state, [tool]);
		let approvals = 0;
		access.setApprover(async () => (++approvals === 1 ? "once" : "deny"));
		await expect(
			access.execute("failed", { tool: "write", reason: "失败", arguments: {} }, undefined, undefined, ctx),
		).rejects.toThrow(/operation failed/);
		await expect(
			access.execute("again", { tool: "write", reason: "再次申请", arguments: {} }, undefined, undefined, ctx),
		).rejects.toThrow();
		expect(approvals).toBe(2);
		expect(access.allows("write")).toBe(false);
	} finally {
		await f.close();
	}
});

test("once bash permits output and stop only for its own job, including after bash is revoked", async () => {
	const f = await toolFixture();
	const jobs = new Supervisor(f.runtime.stateDir, f.cwd, f.policy, {
		wrap: async command => command,
		close: async () => {},
	});
	f.state.jobs = jobs;
	try {
		f.state.config.resources.disabled = ["tool:bash", "tool:job_output", "tool:job_stop"];
		const access = f.state.toolAccess!;
		access.setApprover(async () => "once");
		const command = quoteCommand([
			process.execPath,
			"--no-env-file",
			"-e",
			"console.log('OWNED'); setInterval(()=>{},1000)",
		]);
		const started = await access.execute(
			"background",
			{ tool: "bash", reason: "创建本次后台任务", arguments: { command, background: true } },
			undefined,
			undefined,
			ctx,
		);
		const job = (started.details as { job: Job }).job;
		const unrelated = await jobs.start(
			quoteCommand([process.execPath, "--no-env-file", "-e", "console.log('PRIVATE')"]),
		);
		await jobs.wait(unrelated.id);
		access.revoke("bash");
		access.setApprover(async () => "deny");
		expect(access.isEnabled("job_output")).toBe(true);
		expect(access.allows("job_output", { id: job.id })).toBe(true);
		expect(access.allows("job_stop", { id: job.id })).toBe(true);
		expect(access.allows("job_output")).toBe(false);
		expect(access.allows("job_output", { id: unrelated.id })).toBe(false);
		await expect(
			access.execute(
				"private",
				{ tool: "job_output", reason: "不能查看其它任务", arguments: { id: unrelated.id } },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow();
		const output = await access.execute(
			"owned",
			{ tool: "job_output", reason: "查看自己的任务", arguments: { id: job.id } },
			undefined,
			undefined,
			ctx,
		);
		expect((output.details as { job: Job }).job.id).toBe(job.id);
		const stopped = await access.execute(
			"stop",
			{ tool: "job_stop", reason: "停止自己的任务", arguments: { id: job.id } },
			undefined,
			undefined,
			ctx,
		);
		expect(JSON.stringify(stopped)).not.toContain(unrelated.id);
		expect(JSON.stringify(stopped)).not.toContain("PRIVATE");
		expect(jobs.list().find(value => value.id === job.id)?.status).toBe("cancelled");
		access.clearJobs();
		expect(access.isEnabled("job_output")).toBe(false);
		expect(access.allows("job_output", { id: job.id })).toBe(false);
	} finally {
		await jobs.close();
		await f.close();
	}
}, 30_000);

test("run bash direct calls retain cleanup only for their own job and cannot add an old session job", async () => {
	const f = await toolFixture();
	const jobs = new Supervisor(f.runtime.stateDir, f.cwd, f.policy, {
		wrap: async command => command,
		close: async () => {},
	});
	f.state.jobs = jobs;
	try {
		f.state.config.resources.disabled = ["tool:bash", "tool:job_output", "tool:job_stop"];
		const access = f.state.toolAccess!;
		access.grant("bash");
		const started = await f.run("bash", {
			command: quoteCommand([process.execPath, "--no-env-file", "-e", "setInterval(()=>{},1000)"]),
			background: true,
		});
		const job = (started.details as { job: Job }).job;
		expect(access.allows("job_output", { id: job.id })).toBe(true);
		expect(access.allows("job_stop", { id: "unrelated" })).toBe(false);
		expect(access.list().find(tool => tool.name === "job_output")).toMatchObject({
			enabled: false,
			temporary: false,
			scoped: true,
		});
		access.revoke();
		expect(access.allows("job_stop", { id: job.id })).toBe(true);
		const oldSession = f.state.sessionId;
		access.clearJobs();
		f.state.sessionId = "new-session";
		access.recordJob(oldSession, "bash", started);
		expect(access.allows("job_output", { id: job.id })).toBe(false);
	} finally {
		await jobs.close();
		await f.close();
	}
}, 30_000);

test("revocation during the original write approval also cancels the already approved once call", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const entered = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<"once">();
		f.policy.setApprover(async () => {
			entered.resolve();
			return decision.promise;
		});
		const access = f.state.toolAccess!;
		access.setApprover(async () => "once");
		const target = path.join(f.cwd, "revoked-operation.txt");
		const executing = access.execute("operation", writeRequest(target), undefined, undefined, ctx);
		const rejected = executing.catch((error: unknown) => error);
		await entered.promise;
		access.revoke("write");
		decision.resolve("once");
		expect(await rejected).toBeInstanceOf(Error);
		expect(await Bun.file(target).exists()).toBe(false);
	} finally {
		await f.close();
	}
});
