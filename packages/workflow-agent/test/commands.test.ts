import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { ChangeJournal } from "../src/changes/journal";
import { Policy } from "../src/policy/policy";
import type { RunState } from "../src/runtime/state";
import { restoreFromCommand } from "../src/tui/commands";
import { fixture } from "./helpers";

for (const partial of [false, true])
	test(
		partial
			? "undo reports a restored file outside the recent list when the next file fails"
			: "undo reports every restored file when a turn exceeds the recent list",
		async () => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "undo-notification-")));
			const cwd = path.join(root, "work");
			await fs.mkdir(cwd);
			const targets = Array.from({ length: 105 }, (_value, index) => path.join(cwd, `undo-${index}.txt`));
			const journal = new ChangeJournal(path.join(root, "state"), cwd, async target => {
				if (partial && target === targets[1] && !(await Bun.file(targets[0]).exists()))
					throw new Error("stop after the first restored file");
			});
			const policy = new Policy(cwd, { readRoots: [], writeRoots: [], allowNetwork: false });
			policy.setApprover(async () => "once");
			const messages: string[] = [];
			try {
				for (const target of targets) await journal.capture("large-turn", target, () => Bun.write(target, "agent"));
				await restoreFromCommand(
					{ cwd, policy, journal, jobs: { hasActiveJobs: false } } as RunState,
					{ hasUI: false, ui: { notify: () => {} } } as unknown as ExtensionContext,
					{
						sendMessage(message: { content: unknown }) {
							if (typeof message.content === "string") messages.push(message.content);
						},
					} as ExtensionAPI,
					journal.latestTurn(),
					() => {},
				);
				expect(messages).toHaveLength(1);
				if (partial) {
					expect(messages[0]).toContain("undo-0.txt");
					expect(messages[0]).not.toContain("undo-1.txt");
					expect((await journal.stats()).pending).toBe(104);
					expect(await Bun.file(targets[0]).exists()).toBe(false);
					expect(await Bun.file(targets[1]).text()).toBe("agent");
				} else {
					for (const target of targets) expect(messages[0]).toContain(path.basename(target));
					expect((await journal.stats()).pending).toBe(0);
					expect(await fs.readdir(cwd)).toEqual([]);
				}
			} finally {
				await journal.close();
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30000,
	);

test("permissions commands enable auto for real writes without an approving callback", async () => {
	const f = await fixture();
	try {
		f.callTool("write", { path: "auto.txt", content: "AUTO_MODE_WRITE_OK" });
		const run = await f.run({
			action: "commands",
			commands: ["/permissions auto", "/session"],
			promptAfterCommands: "Create auto.txt in this project",
		});
		expect(run.code, run.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "auto.txt")).text()).toBe("AUTO_MODE_WRITE_OK");
		const info = JSON.parse(run.result.displays.find((item: { title: string }) => item.title === "会话信息").text);
		expect(info.permissions).toBe("auto");
	} finally {
		await f.close();
	}
}, 30000);

test("full access is selected by a human command and is not inherited by resume", async () => {
	const f = await fixture();
	try {
		const external = path.join(f.root, "outside.txt");
		f.callTool("write", { path: external, content: "FULL_EXTERNAL_OK" });
		const first = await f.run({
			action: "commands",
			commands: ["/permissions full"],
			promptAfterCommands: "Create the selected outside file",
		});
		expect(first.code, first.stderr).toBe(0);
		expect(await Bun.file(external).text()).toBe("FULL_EXTERNAL_OK");
		const resumed = await f.run({ resume: first.result.sessionFile, action: "commands", commands: ["/session"] });
		expect(resumed.code, resumed.stderr).toBe(0);
		const info = JSON.parse(
			resumed.result.displays.find((item: { title: string }) => item.title === "会话信息").text,
		);
		expect(info.permissions).toBe("manual");
	} finally {
		await f.close();
	}
}, 30000);

test("basic information commands show product state without calling the model or enabling native subcommands", async () => {
	const f = await fixture();
	try {
		const run = await f.run({
			action: "commands",
			commands: [
				"/help",
				"/context",
				"/usage",
				"/session",
				"/tools",
				"/jobs",
				"/todo",
				"/mcp reload",
				"/session delete",
				"/compact remote",
			],
		});
		expect(run.code, run.stderr).toBe(0);
		const help = run.result.displays.find((item: { title: string }) => item.title === "命令帮助").text;
		expect(help).toContain("/redo");
		expect(help).toContain("/undo");
		expect(help).not.toContain("/reload-plugins");
		const tools = run.result.displays.find((item: { title: string }) => item.title === "工具状态 · 只读").text;
		expect(tools).toMatch(/基线启用[^\n]*write/);
		expect(tools).not.toMatch(/(?:基线启用|临时启用|关闭)[^\n]*eval/);
		expect(run.result.displays.some((item: { title: string }) => item.title === "上下文")).toBe(true);
		expect(run.result.displays.some((item: { title: string }) => item.title === "本地用量")).toBe(true);
		expect(run.result.notifications.filter((text: string) => text.includes("用法"))).toHaveLength(3);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30000);

test("effort and plan commands change only the active session and reject unsupported arguments", async () => {
	const f = await fixture();
	try {
		const run = await f.run({
			action: "commands",
			commands: ["/effort low", "/effort impossible", "/plan", "/plan extra"],
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.thinking).toBe("low");
		expect(run.result.notifications.some((text: string) => text.includes("计划模式"))).toBe(true);
		expect(run.result.notifications.filter((text: string) => text.includes("用法"))).toHaveLength(2);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30000);

for (const command of ["/retry", "/redo"])
	test(`${command} resumes the failed turn without inserting another user prompt`, async () => {
		const f = await fixture();
		try {
			f.failModel(401, "fixture failed once");
			const first = await f.run();
			expect(first.code, first.stderr).toBe(0);
			expect(first.result.messages.at(-1).stopReason).toBe("error");
			f.recoverModel();
			const second = await f.run({ resume: first.result.sessionFile, action: "commands", commands: [command] });
			expect(second.code, second.stderr).toBe(0);
			expect(second.result.messages.at(-1).content).toContainEqual({ type: "text", text: "LOCAL_PRODUCT_OK" });
			expect(second.result.messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(1);
			expect(f.requests).toHaveLength(2);
		} finally {
			await f.close();
		}
	}, 30000);

test("undo restores the latest file turn, preserves earlier edits and history, and can continue after resume", async () => {
	const f = await fixture();
	try {
		const first = await f.run({ action: "undo", approve: true });
		expect(first.code, first.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "existing.txt")).text()).toBe("first turn");
		expect(await Bun.file(path.join(f.cwd, "created.txt")).exists()).toBe(false);
		expect((await fs.stat(path.join(f.cwd, "existing.txt"))).mode & 0o777).toBe(0o755);
		expect(first.result.changes.filter((item: { restored: boolean }) => item.restored)).toHaveLength(3);
		expect(
			first.result.messages.some(
				(item: { role: string; customType?: string }) => item.role === "custom" && item.customType === "file-undo",
			),
		).toBe(true);
		expect(first.result.messages.filter((item: { role: string }) => item.role === "user")).toHaveLength(1);
		expect(f.requests).toHaveLength(1);
		const second = await f.run({
			resume: first.result.sessionFile,
			approve: true,
			action: "commands",
			commands: ["/undo", "/undo"],
		});
		expect(second.code, second.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "existing.txt")).text()).toBe("user original");
		expect(second.result.changes.every((item: { restored: boolean }) => item.restored)).toBe(true);
		expect(f.requests).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30000);

for (const scenario of [
	"conflict",
	"denied",
	"plan-after-approval",
	"queued-plan",
	"pending-job",
	"late-plan",
] as const)
	test(`undo preserves all files when ${scenario}`, async () => {
		const f = await fixture();
		try {
			const run = await f.run({
				action: "undo",
				approve: scenario !== "denied",
				undoScenario: scenario === "denied" ? "normal" : scenario,
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "existing.txt")).text()).toBe("second final");
			expect(await Bun.file(path.join(f.cwd, "created.txt")).text()).toBe(
				scenario === "conflict" ? "user continued editing" : "new file",
			);
			expect(run.result.changes.every((item: { restored: boolean }) => !item.restored)).toBe(true);
			const reason =
				scenario === "conflict"
					? "冲突"
					: scenario === "denied"
						? "拒绝"
						: scenario === "pending-job"
							? "后台任务"
							: "计划模式";
			expect(run.result.notifications.some((text: string) => text.includes(reason))).toBe(true);
			expect(run.result.messages.some((item: { customType?: string }) => item.customType === "file-undo")).toBe(
				false,
			);
		} finally {
			await f.close();
		}
	}, 30000);

test("undo keeps separate file turns across retries resumed in different processes", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "round.txt"), "user original");
		f.callTools([
			{ name: "write", arguments: { path: "round.txt", content: "first attempt" } },
			{ name: "write", arguments: { path: "round.txt", content: "second attempt" } },
			{ name: "write", arguments: { path: "round.txt", content: "third attempt" } },
		]);
		f.failAfterTools(1);
		const first = await f.run({ approve: true });
		expect(first.code, first.stderr).toBe(0);
		expect(first.result.messages.at(-1).stopReason).toBe("error");
		f.failAfterTools(2);
		const second = await f.run({
			resume: first.result.sessionFile,
			approve: true,
			action: "commands",
			commands: ["/retry"],
		});
		expect(second.code, second.stderr).toBe(0);
		expect(second.result.messages.at(-1).stopReason).toBe("error");
		expect(await Bun.file(path.join(f.cwd, "round.txt")).text()).toBe("second attempt");
		f.failAfterTools(undefined);
		const third = await f.run({
			resume: first.result.sessionFile,
			approve: true,
			action: "commands",
			commands: ["/redo"],
		});
		expect(third.code, third.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "round.txt")).text()).toBe("third attempt");
		const undo = await f.run({
			resume: first.result.sessionFile,
			approve: true,
			action: "commands",
			commands: ["/undo"],
		});
		expect(undo.code, undo.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "round.txt")).text()).toBe("second attempt");
	} finally {
		await f.close();
	}
}, 30000);

test("fresh preserves the transcript and next request uses new provider connection state", async () => {
	const f = await fixture();
	try {
		const first = await f.run();
		const fresh = await f.run({
			resume: first.result.sessionFile,
			action: "commands",
			commands: ["/fresh", "/retry", "/redo extra"],
			promptAfterCommands: "AFTER_FRESH",
		});
		expect(fresh.code, fresh.stderr).toBe(0);
		expect(fresh.result.messages.filter((item: { role: string }) => item.role === "user")).toHaveLength(2);
		expect(f.requests).toHaveLength(2);
		expect(JSON.stringify(f.requests[1].messages)).toContain("PRODUCT_HISTORY");
		expect(JSON.stringify(f.requests[1].messages)).toContain("AFTER_FRESH");
		expect(f.requestHeaders[1].sessionId).not.toBe(f.requestHeaders[0].sessionId);
		expect(fresh.result.sessionFile).toBe(first.result.sessionFile);
		expect(fresh.result.notifications.some((text: string) => text.includes("没有可重试"))).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

test("undo preview and its actual approval may both outlast the input handler budget", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "undo", undoScenario: "slow-ui" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult).toEqual({ handled: true });
		expect(await Bun.file(path.join(f.cwd, "existing.txt")).text()).toBe("first turn");
		expect(run.result.notifications.some((text: string) => text.includes("timed out"))).toBe(false);
	} finally {
		await f.close();
	}
}, 30000);

for (const resumed of [false, true])
	test(`undo notification is kept when ${resumed ? "resumed redo" : "retry"} continues a failed model response`, async () => {
		const f = await fixture();
		try {
			await Bun.write(path.join(f.cwd, "retry-undo.txt"), "user original");
			f.callTools([{ name: "write", arguments: { path: "retry-undo.txt", content: "agent modification" } }]);
			f.failAfterTools(1);
			const first = await f.run({ approve: true });
			expect(first.code, first.stderr).toBe(0);
			f.failAfterTools(undefined);
			let sessionFile = first.result.sessionFile;
			if (resumed) {
				const undo = await f.run({ resume: sessionFile, action: "commands", approve: true, commands: ["/undo"] });
				expect(undo.code, undo.stderr).toBe(0);
				sessionFile = undo.result.sessionFile;
			}
			const retry = await f.run({
				resume: sessionFile,
				action: "commands",
				approve: true,
				commands: resumed ? ["/redo"] : ["/undo", "/retry"],
			});
			expect(retry.code, retry.stderr).toBe(0);
			expect(retry.result.messages.at(-1).content).toContainEqual({ type: "text", text: "LOCAL_PRODUCT_OK" });
			expect(await Bun.file(path.join(f.cwd, "retry-undo.txt")).text()).toBe("user original");
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("retry-undo.txt");
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("重新读取");
		} finally {
			await f.close();
		}
	}, 30000);
