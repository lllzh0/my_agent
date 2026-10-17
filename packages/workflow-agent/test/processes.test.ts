import assert from "node:assert/strict";
import { test } from "bun:test";
import * as fs from "node:fs/promises";
const { mkdtemp, rm } = fs;
import * as os from "node:os";
const { tmpdir } = os;
import * as path from "node:path";
const { join } = path;
import { Supervisor } from "../src/processes/supervisor.ts";
import { Policy } from "../src/policy/policy.ts";
import { executionEnvironment } from "../src/processes/environment";

test("background processes return a task, provide incremental logs and cancel process group", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-jobs-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	try {
		const job = await jobs.start("printf 'ready\\n'; sleep 30 & wait", { timeoutMs: 20_000 });
		assert.equal(job.status, "running");
		for (let i = 0; i < 100 && !jobs.output(job.id, 0).text.includes("ready"); i++) await Bun.sleep(10);
		const output = jobs.output(job.id, 0);
		assert.ok(output.text.includes("ready"));
		assert.equal(jobs.output(job.id, output.cursor).text, "");
		await jobs.stop(job.id);
		assert.equal(jobs.list()[0].status, "cancelled");
		assert.throws(() => process.kill(-job.pid!, 0), /ESRCH/);
	} finally {
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("a failed isolation backend never runs an unwrapped command", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-no-fallback-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const jobs = new Supervisor(home, home, policy, {
		wrap: async () => {
			throw new Error("sandbox unavailable");
		},
		close: async () => {},
	});
	try {
		await assert.rejects(jobs.start("echo escaped"), /sandbox unavailable/);
		assert.equal(jobs.list().length, 0);
	} finally {
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("full access actually bypasses the isolation backend while retaining managed completion", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-full-job-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprovalMode("full");
	const jobs = new Supervisor(home, home, policy, {
		wrap: async () => {
			throw new Error("must not use sandbox in full mode");
		},
		close: async () => {},
	});
	try {
		const completed = await jobs.wait((await jobs.start("printf FULL_JOB_OK > full.txt")).id);
		assert.equal(completed.status, "succeeded");
		assert.equal(await Bun.file(join(home, "full.txt")).text(), "FULL_JOB_OK");
	} finally {
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("command environment exposes only selected variable names except in explicit full access", () => {
	const name = "MY_AGENT_TEST_SELECTED_SETTING";
	const original = process.env[name];
	try {
		process.env[name] = "selected-value";
		assert.equal(executionEnvironment("/tmp/product")[name], undefined);
		assert.equal(executionEnvironment("/tmp/product", [name])[name], "selected-value");
		assert.equal(executionEnvironment("/tmp/product", [], true)[name], "selected-value");
	} finally {
		if (original === undefined) delete process.env[name];
		else process.env[name] = original;
	}
});

test("a mode change during sandbox preparation cannot start the previously authorized command", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-preparing-permission-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const preparing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	const jobs = new Supervisor(home, home, policy, {
		wrap: () => {
			preparing.resolve();
			return release.promise;
		},
		close: async () => {},
	});
	const pending = jobs.start("touch forbidden.txt");
	try {
		await preparing.promise;
		policy.setApprovalMode("full");
		release.resolve("touch forbidden.txt");
		await assert.rejects(pending, /状态|变更/);
		assert.equal(await Bun.file(join(home, "forbidden.txt")).exists(), false);
	} finally {
		release.resolve("true");
		await pending.catch(() => undefined);
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("cancelling a background launch while approval is pending prevents its process from starting", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-background-approval-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	const started = Promise.withResolvers<void>();
	const approval = Promise.withResolvers<"once">();
	const controller = new AbortController();
	policy.setApprover(() => {
		started.resolve();
		return approval.promise;
	});
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	const pending = jobs.start("printf unwanted > cancelled.txt", { startSignal: controller.signal });
	try {
		await started.promise;
		controller.abort(new Error("launch cancelled"));
		approval.resolve("once");
		await assert.rejects(pending, /cancel/);
		assert.equal(await Bun.file(join(home, "cancelled.txt")).exists(), false);
	} finally {
		approval.resolve("once");
		await pending.catch(() => undefined);
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("revoking full access immediately after authorization cannot start a command under the new mode", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-revoked-start-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprovalMode("full");
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	const pending = jobs.start("printf forbidden > marker.txt");
	policy.setApprovalMode("manual");
	try {
		await assert.rejects(pending, /状态|变更/);
		assert.equal(await Bun.file(join(home, "marker.txt")).exists(), false);
	} finally {
		await pending.catch(() => undefined);
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("a successful shell cannot leave background descendants running after its job completes", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-finished-descendant-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	let descendant: number | undefined;
	try {
		const job = await jobs.start("sleep 30 >/dev/null 2>&1 & echo $!");
		const result = await jobs.wait(job.id);
		descendant = Number(result.log.trim());
		assert.ok(Number.isInteger(descendant) && descendant > 0);
		assert.equal(result.status, "succeeded");
		await jobs.close();
		// Allow the OS to reap the orphan after the supervisor has signalled its group.
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				process.kill(descendant, 0);
			} catch {
				break;
			}
			await Bun.sleep(10);
		}
		assert.throws(() => process.kill(descendant!, 0), /ESRCH/);
	} finally {
		if (descendant) {
			try {
				process.kill(descendant, "SIGKILL");
			} catch {}
		}
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("closing while a command is preparing prevents it from starting after shutdown", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-closing-job-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const preparing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	const jobs = new Supervisor(home, home, policy, {
		wrap: () => {
			preparing.resolve();
			return release.promise;
		},
		close: async () => {},
	});
	const pending = jobs.start("printf 'must not start'");
	try {
		await preparing.promise;
		await jobs.close();
		release.resolve("printf 'must not start'");
		await assert.rejects(pending, /已关闭/);
		assert.equal(jobs.list().length, 0);
		await assert.rejects(jobs.start("echo another"), /已关闭/);
	} finally {
		release.resolve("true");
		await pending.catch(() => undefined);
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("the four-command limit also counts requests waiting for approval", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-pending-jobs-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	const approval = Promise.withResolvers<"deny">();
	policy.setApprover(() => approval.promise);
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	const pending = Array.from({ length: 4 }, (_, index) => jobs.start(`echo ${index}`));
	const fifth = jobs.start("echo fifth");
	try {
		// Resolve approvals after the fifth request has had a chance to reject at capacity.
		approval.resolve("deny");
		await assert.rejects(fifth, /最多运行 4/);
		await Promise.allSettled(pending);
		assert.equal(jobs.list().length, 0);
	} finally {
		approval.resolve("deny");
		await Promise.allSettled([...pending, fifth]);
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("entering plan mode during backend preparation prevents the approved command from spawning", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-preparing-plan-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const preparing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	const jobs = new Supervisor(home, home, policy, {
		wrap: () => {
			preparing.resolve();
			return release.promise;
		},
		close: async () => {},
	});
	const pending = jobs.start("touch after-plan");
	try {
		await preparing.promise;
		policy.mode = "plan";
		release.resolve("touch after-plan");
		await assert.rejects(pending, /计划模式/);
		assert.equal(jobs.list().length, 0);
		assert.equal(await Bun.file(join(home, "after-plan")).exists(), false);
	} finally {
		release.resolve("true");
		await pending.catch(() => undefined);
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("timeout finishes even when a detached descendant keeps the output pipes open", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-detached-pipes-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.setApprover(async () => "once");
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	let descendant: number | undefined;
	try {
		const job = await jobs.start(
			"/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); $| = 1; print qq($$\\n); sleep 10' & wait",
			{ timeoutMs: 200 },
		);
		for (let i = 0; i < 100 && !jobs.output(job.id).text.trim(); i++) await Bun.sleep(10);
		descendant = Number(jobs.output(job.id).text.trim());
		assert.ok(Number.isInteger(descendant) && descendant > 0);
		const outcome = await Promise.race([jobs.wait(job.id), Bun.sleep(2000).then(() => undefined)]);
		assert.equal(outcome?.status, "timed_out");
		assert.ok(outcome?.endedAt);
	} finally {
		if (descendant) {
			try {
				process.kill(descendant, "SIGKILL");
			} catch {}
		}
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("a literal Git command still runs only after a person grants metadata writes in auto mode", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-git-approval-"));
	const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
	let prompts = 0;
	policy.setApprover(async () => {
		prompts++;
		return "once";
	});
	policy.setApprovalMode("auto");
	policy.setReviewer(async () => ({ decision: "allow", risk: "low", reason: "routine command" }));
	const jobs = new Supervisor(home, home, policy, { wrap: async command => command, close: async () => {} });
	try {
		const job = await jobs.wait((await jobs.start("git --version", { gitWrite: true })).id);
		assert.equal(job.status, "succeeded");
		assert.equal(prompts, 1);
	} finally {
		await jobs.close();
		await rm(home, { recursive: true, force: true });
	}
});

for (const [syntax, command] of [
	["newline", "git --version\n/usr/bin/touch escaped.txt"],
	["double-quoted substitution", 'git --version "$(/usr/bin/touch escaped.txt)"'],
	["backtick substitution", "git --version `/usr/bin/touch escaped.txt`"],
] as const) {
	test(`Git metadata permission refuses ${syntax} before running any command`, async () => {
		const home = await mkdtemp(join(tmpdir(), "agent-git-syntax-"));
		const policy = new Policy(home, { readRoots: [], writeRoots: [], allowNetwork: false });
		policy.setApprover(async () => "once");
		const jobs = new Supervisor(home, home, policy, { wrap: async value => value, close: async () => {} });
		try {
			await assert.rejects(jobs.start(command, { gitWrite: true }), /Git.*单条/);
			assert.equal(await Bun.file(join(home, "escaped.txt")).exists(), false);
		} finally {
			await jobs.close();
			await rm(home, { recursive: true, force: true });
		}
	});
}
