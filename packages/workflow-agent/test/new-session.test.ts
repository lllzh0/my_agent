import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fixture } from "./helpers";

test("new command clears current records without a model call and old conversation remains resumable", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "source.txt"), "OLD_SOURCE_BODY");
		f.callTools([
			{ name: "write", arguments: { path: "old.txt", content: "OLD_FILE" } },
			{ name: "task_list", arguments: { titles: ["OLD_TASK"] } },
			{ name: "read_document", arguments: { path: "source.txt" } },
		]);
		const fresh = await f.run({
			approve: true,
			action: "commands",
			promptsBefore: ["OLD_CONVERSATION"],
			commands: ["/permissions full", "/new", "/session"],
		});
		expect(fresh.code, fresh.stderr).toBe(0);
		const oldId = f.requestHeaders[0].sessionId!;
		expect(fresh.result.stateSessionId).not.toBe(oldId);
		expect(fresh.result.workflow).toEqual([]);
		expect(fresh.result.changes).toEqual([]);
		expect(fresh.result.sources).toEqual([]);
		expect(fresh.result.messages).toEqual([]);
		const info = JSON.parse(fresh.result.displays.find((item: { title: string }) => item.title === "会话信息").text);
		expect(info.permissions).toBe("manual");
		expect(f.requests).toHaveLength(4);
		const restored = await f.run({ action: "commands", commands: [`/resume ${oldId}`] });
		expect(restored.code, restored.stderr).toBe(0);
		expect(restored.result.stateSessionId).toBe(oldId);
		expect(restored.result.workflow[0].title).toBe("OLD_TASK");
		expect(restored.result.changes).toHaveLength(1);
		expect(restored.result.sources[0].id).toBe("S1");
		expect(JSON.stringify(restored.result.messages)).toContain("OLD_CONVERSATION");
		expect(f.requests).toHaveLength(4);
		const emptyResumed = await f.run({ resume: fresh.result.sessionFile, action: "commands", commands: [] });
		expect(emptyResumed.code, emptyResumed.stderr).toBe(0);
		expect(emptyResumed.result.messages).toEqual([]);
		expect(emptyResumed.result.stateSessionId).toBe(fresh.result.stateSessionId);
	} finally {
		await f.close();
	}
}, 30_000);

test("failed or cancelled new session keeps the source usable and removes only its staged target", async () => {
	const f = await fixture();
	try {
		for (const newScenario of ["switch-failure", "cancelled", "late-cancelled"] as const) {
			const run = await f.run({
				action: "product-new",
				newScenario,
				promptsBefore: ["BEFORE_FAILED_NEW"],
				promptAfterCommands: "AFTER_FAILED_NEW",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.stateSessionId).toBe(run.result.actionResult.source.id);
			expect(run.result.actionResult.error).not.toBe("");
			expect(run.result.actionResult.busy).toBe(false);
			expect(JSON.stringify(run.result.messages)).toContain("BEFORE_FAILED_NEW");
			expect(JSON.stringify(run.result.messages)).toContain("AFTER_FAILED_NEW");
		}
		const transcripts = (await fs.readdir(path.join(f.home, "sessions"))).filter(file => file.endsWith(".jsonl"));
		expect(transcripts).toHaveLength(3);
	} finally {
		await f.close();
	}
}, 30_000);

test("new session finishes record activation after UI failure and blocks native entry points while switching", async () => {
	const f = await fixture();
	try {
		for (const newScenario of ["post-switch-failure", "guarded"] as const) {
			const run = await f.run({
				action: "product-new",
				newScenario,
				promptsBefore: ["OLD_HISTORY"],
				promptAfterCommands: "NEW_HISTORY",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.stateSessionId).not.toBe(run.result.actionResult.source.id);
			expect(JSON.stringify(run.result.messages)).not.toContain("OLD_HISTORY");
			expect(JSON.stringify(run.result.messages)).toContain("NEW_HISTORY");
			expect(run.result.actionResult.busy).toBe(false);
			if (newScenario === "post-switch-failure") expect(run.result.actionResult.result.refreshFailed).toBe(true);
			else expect(run.result.actionResult.checks).toEqual(Array(6).fill("blocked"));
		}
	} finally {
		await f.close();
	}
}, 30_000);

test("extension cannot create a session and new with arguments cannot become a provider prompt", async () => {
	const f = await fixture();
	try {
		const blocked = await f.run({ action: "input", inputSource: "extension", command: "/new" });
		expect(blocked.code, blocked.stderr).toBe(0);
		expect(blocked.result.actionResult.handled).toBe(true);
		expect(blocked.result.notifications.some((text: string) => text.includes("用户"))).toBe(true);
		const args = await f.run({ action: "submit", command: "/new unexpected" });
		expect(args.code, args.stderr).toBe(0);
		expect(args.result.notifications.some((text: string) => text.includes("用法"))).toBe(true);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("blank product sessions are persisted and new creates two resumable identities without model calls", async () => {
	const f = await fixture();
	try {
		const created = await f.run({ action: "product-new" });
		expect(created.code, created.stderr).toBe(0);
		const source = created.result.actionResult.source;
		expect(await Bun.file(source.file).exists()).toBe(true);
		expect(created.result.messages).toEqual([]);
		expect(created.result.actionResult.sessions.map((session: { id: string }) => session.id)).toEqual([source.id]);
		expect((await fs.readdir(path.join(f.home, "sessions"))).filter(file => file.endsWith(".jsonl"))).toHaveLength(2);
		const restored = await f.run({ resume: source.file, action: "commands", commands: [] });
		expect(restored.code, restored.stderr).toBe(0);
		expect(restored.result.stateSessionId).toBe(source.id);
		expect(restored.result.messages).toEqual([]);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("a persisted blank root session retains exclusive ownership until its host closes", async () => {
	const f = await fixture();
	let owner: Promise<unknown> | undefined;
	try {
		const blank = await f.run({ action: "commands", commands: [] });
		expect(blank.code, blank.stderr).toBe(0);
		owner = f.run({ resume: blank.result.sessionFile, action: "hold-blank-session" });
		for (let i = 0; i < 200 && !(await Bun.file(path.join(f.home, "owner-ready")).exists()); i++) await Bun.sleep(10);
		expect(await Bun.file(path.join(f.home, "owner-ready")).exists()).toBe(true);
		const before = await Bun.file(blank.result.sessionFile).text();
		const denied = await f.run({ resume: blank.result.sessionFile, action: "commands", commands: [] });
		expect(denied.code, denied.stderr).toBe(1);
		expect(denied.stderr).toContain("占用");
		expect(await Bun.file(blank.result.sessionFile).text()).toBe(before);
		await Bun.write(path.join(f.home, "owner-release"), "release");
		await owner;
		owner = undefined;
		const restored = await f.run({ resume: blank.result.sessionFile, action: "commands", commands: [] });
		expect(restored.code, restored.stderr).toBe(0);
		expect(restored.result.stateSessionId).toBe(blank.result.stateSessionId);
		expect(restored.result.messages).toEqual([]);
		expect(f.requests).toHaveLength(0);
	} finally {
		await Bun.write(path.join(f.home, "owner-release"), "release");
		await owner;
		await f.close();
	}
}, 30_000);
