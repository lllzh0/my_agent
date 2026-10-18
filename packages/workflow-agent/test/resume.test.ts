import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { fixture } from "./helpers";

test("/resume restores the native transcript and rebinds file, source and task tools to that session", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "source.txt"), "SAVED_SOURCE_EVIDENCE");
		const calls = [
			{ name: "write", arguments: { path: "old.txt", content: "OLD_SESSION_FILE" } },
			{ name: "task_list", arguments: { titles: ["Saved task"] } },
			{ name: "read_document", arguments: { path: "source.txt" } },
		];
		f.callTools(calls);
		const old = await f.run({ approve: true });
		expect(old.code, old.stderr).toBe(0);
		f.callTools(
			[
				...calls,
				{
					name: "write_report",
					arguments: { path: "resumed.md", claims: [{ text: "Saved evidence", sourceIds: ["S1"] }] },
				},
				{ name: "task_update", arguments: { index: 0, status: "completed", evidence: "resumed.md" } },
			],
			"AFTER_RESUME",
		);
		const resumed = await f.run({
			action: "resume",
			approve: true,
			commands: ["/permissions full", `/resume ${old.result.stateSessionId}`, "/session"],
			promptAfterCommands: "AFTER_RESUME",
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.result.sessionFile).toBe(old.result.sessionFile);
		expect(resumed.result.stateSessionId).toBe(old.result.stateSessionId);
		expect(resumed.result.stateDir).toBe(old.result.stateDir);
		expect(resumed.result.changes).toHaveLength(2);
		expect(resumed.result.sources[0].id).toBe("S1");
		expect(resumed.result.workflow[0].status).toBe("completed");
		expect(await Bun.file(path.join(f.cwd, "resumed.md")).text()).toContain("S1");
		expect(JSON.stringify(resumed.result.messages)).not.toContain("CURRENT_SESSION_ONLY");
		const info = JSON.parse(
			resumed.result.displays.find((item: { title: string }) => item.title === "会话信息").text,
		);
		expect(info.permissions).toBe("manual");
		const undone = await f.run({
			resume: old.result.sessionFile,
			action: "commands",
			approve: true,
			commands: ["/undo"],
		});
		expect(undone.code, undone.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "resumed.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(f.cwd, "old.txt")).text()).toBe("OLD_SESSION_FILE");
	} finally {
		await f.close();
	}
}, 30000);

test("the native session list is limited to this workspace and owned product records", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		expect(old.code, old.stderr).toBe(0);
		const other = path.join(f.root, "other-workspace");
		await fs.mkdir(other);
		const foreign = await f.run({ cwd: other });
		expect(foreign.code, foreign.stderr).toBe(0);
		await Bun.write(path.join(f.home, "sessions", "broken.jsonl"), "{broken");
		const listed = await f.run({ action: "list-sessions" });
		expect(listed.code, listed.stderr).toBe(0);
		expect(listed.result.actionResult.map((item: { path: string }) => item.path)).toEqual([old.result.sessionFile]);
		await fs.rm(path.join(old.result.stateDir, "manifest.json"));
		const orphaned = await f.run({ action: "list-sessions" });
		expect(orphaned.code, orphaned.stderr).toBe(0);
		// A successfully opened product session now persists even with no chat.
		// Only that previous owned blank session may join the list; foreign,
		// malformed, current and orphaned transcripts must still be excluded.
		expect(orphaned.result.actionResult.map((item: { path: string }) => item.path)).toEqual([
			listed.result.sessionFile,
		]);
		expect(orphaned.result.actionResult[0].id).toBe(listed.result.stateSessionId);
		expect(orphaned.result.actionResult[0].messageCount).toBe(0);
		expect(orphaned.result.actionResult[0].cwd).toBe(await fs.realpath(f.cwd));
	} finally {
		await f.close();
	}
}, 30000);

test("cancelling /resume keeps the current conversation and does not request a model turn", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const cancelled = await f.run({ action: "resume", commands: ["/resume"], resumeSelection: "cancel" });
		expect(cancelled.code, cancelled.stderr).toBe(0);
		expect(cancelled.result.sessionFile).not.toBe(old.result.sessionFile);
		expect(cancelled.result.resumePickerShown).toBe(1);
		expect(JSON.stringify(cancelled.result.messages)).toContain("CURRENT_SESSION_ONLY");
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30000);

test("/resume refuses a session held by another process without changing its file", async () => {
	const f = await fixture();
	let owner: Promise<unknown> | undefined;
	try {
		const old = await f.run();
		const owning = f.run({ resume: old.result.sessionFile, action: "hold-session" });
		owner = owning;
		const readyPath = path.join(f.home, "owner-ready");
		await Promise.race([
			untilAborted(AbortSignal.timeout(10000), async () => {
				// A missing BunFile caches exists=false; reopen it to observe the owner.
				while (!(await Bun.file(readyPath).exists())) await Bun.sleep(10);
			}),
			owning.then(result => {
				throw new Error(`Owner exited before readiness (${result.code}): ${result.stderr}`);
			}),
		]);
		expect(await Bun.file(path.join(f.home, "owner-ready")).exists()).toBe(true);
		const before = await Bun.file(old.result.sessionFile).text();
		const denied = await f.run({
			action: "resume",
			commands: [`/resume ${old.result.stateSessionId}`],
			promptAfterCommands: "OWNER_REFUSAL_KEPT_SOURCE",
		});
		expect(denied.code, denied.stderr).toBe(0);
		expect(denied.result.sessionFile).not.toBe(old.result.sessionFile);
		expect(denied.result.notifications.some((text: string) => text.includes("占用"))).toBe(true);
		expect(await Bun.file(old.result.sessionFile).text()).toBe(before);
	} finally {
		await Bun.write(path.join(f.home, "owner-release"), "release");
		await owner;
		await f.close();
	}
}, 30000);

test("a native switch failure keeps the source usable and releases staged target records for retry", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const resumed = await f.run({
			action: "resume",
			resumeScenario: "switch-failure",
			commands: [`/resume ${old.result.stateSessionId}`, "/session", `/resume ${old.result.stateSessionId}`],
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.result.notifications.some((text: string) => text.includes("fixture native switch failed"))).toBe(
			true,
		);
		expect(resumed.result.sessionFile).toBe(old.result.sessionFile);
		expect(resumed.result.stateSessionId).toBe(old.result.stateSessionId);
	} finally {
		await f.close();
	}
}, 30000);

test("/resume refuses a busy background task without stopping it or switching histories", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const busy = await f.run({
			action: "resume",
			resumeScenario: "busy",
			commands: [`/resume ${old.result.stateSessionId}`],
		});
		expect(busy.code, busy.stderr).toBe(0);
		expect(busy.result.sessionFile).not.toBe(old.result.sessionFile);
		expect(busy.result.jobs[0].status).toBe("running");
		expect(busy.result.notifications.some((text: string) => text.includes("后台任务"))).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

test("a UI refresh error after native commit still activates the target records and resets full access", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const resumed = await f.run({
			action: "resume",
			resumeScenario: "post-switch-failure",
			commands: ["/permissions full", `/resume ${old.result.stateSessionId}`, "/session"],
			promptAfterCommands: "CONTINUE_AFTER_RENDER_FAILURE",
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.result.stateSessionId).toBe(old.result.stateSessionId);
		expect(resumed.result.stateDir).toBe(old.result.stateDir);
		expect(resumed.result.sessionFile).toBe(old.result.sessionFile);
		expect(resumed.result.notifications.some((text: string) => text.includes("界面刷新"))).toBe(true);
		const info = JSON.parse(
			resumed.result.displays.find((item: { title: string }) => item.title === "会话信息").text,
		);
		expect(info.permissions).toBe("manual");
		expect(JSON.stringify(resumed.result.messages)).toContain("CONTINUE_AFTER_RENDER_FAILURE");
	} finally {
		await f.close();
	}
}, 30000);

test("all native prompt and retry entry points are blocked until product records finish switching", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		f.callTools(
			[{ name: "task_list", arguments: { titles: ["MUST_NOT_WRITE_SOURCE_RECORDS"] } }],
			"ATTEMPT_DURING_SWITCH",
		);
		const resumed = await f.run({
			action: "resume",
			resumeScenario: "input-during-switch",
			commands: [`/resume ${old.result.stateSessionId}`],
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.result.resumeChecks).toEqual(["blocked", "blocked", "blocked", "blocked", "blocked"]);
		expect(resumed.result.workflow).toEqual([]);
		expect(JSON.stringify(f.requests)).not.toContain("ATTEMPT_DURING_SWITCH");
	} finally {
		await f.close();
	}
}, 30000);

test("the native retry key reports a blocked switch without an unhandled rejection or clearing the draft", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const resumed = await f.run({
			action: "resume",
			resumeScenario: "retry-key-during-switch",
			commands: [`/resume ${old.result.stateSessionId}`],
			promptAfterCommands: "CONTINUE_AFTER_RETRY_KEY",
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.result.notifications.some((text: string) => text.includes("正在切换会话"))).toBe(true);
		expect(resumed.result.resumeChecks).toEqual([]);
		expect(resumed.result.stateSessionId).toBe(old.result.stateSessionId);
		expect(JSON.stringify(resumed.result.messages)).toContain("CONTINUE_AFTER_RETRY_KEY");
	} finally {
		await f.close();
	}
}, 30000);

test("disposing during resume waits for the transition and closes its final active records", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const closed = await f.run({ action: "dispose-during-resume", command: old.result.sessionFile });
		expect(closed.code, closed.stderr).toBe(0);
		expect(closed.result.actionResult).toBe("closed");
		const reopened = await f.run({ resume: old.result.sessionFile });
		expect(reopened.code, reopened.stderr).toBe(0);
	} finally {
		await f.close();
	}
}, 30000);

test("incompatible selected resources refuse /resume and leave the current session usable", async () => {
	const f = await fixture();
	try {
		const old = await f.run();
		const instruction = path.join(f.root, "selected.md");
		await Bun.write(instruction, "SELECTED_RESOURCE");
		f.config.resources.instructions = [instruction];
		const denied = await f.run({
			action: "resume",
			commands: [`/resume ${old.result.stateSessionId}`],
			promptAfterCommands: "STILL_USABLE",
		});
		expect(denied.code, denied.stderr).toBe(0);
		expect(denied.result.sessionFile).not.toBe(old.result.sessionFile);
		expect(denied.result.notifications.some((text: string) => text.includes("配置"))).toBe(true);
		expect(JSON.stringify(denied.result.messages)).toContain("STILL_USABLE");
	} finally {
		await f.close();
	}
}, 30000);
