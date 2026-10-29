import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { builtinPreset } from "../src/presets/presets";
import { fixture } from "./helpers";
import { JournalStore } from "../src/changes/store";
import { Database } from "bun:sqlite";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

function openTerminal(home: string, cwd: string, args: string[] = []) {
	const terminal = new VirtualTerminal(120, 42);
	const decoder = new TextDecoder();
	let output = "";
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			path.resolve(import.meta.dir, "../src/launcher.ts"),
			"--home",
			home,
			"--cwd",
			cwd,
			...args,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: os.homedir(),
				TERM: "xterm-256color",
				PRODUCT_TEST_KEY: "terminal-local-key",
				PI_TEST_SESSION_OWNERS_DIR: process.env.PI_TEST_SESSION_OWNERS_DIR,
			},
			terminal: {
				cols: 120,
				rows: 42,
				data(_terminal, data) {
					const text = decoder.decode(data, { stream: true });
					output += text;
					terminal.write(text);
				},
			},
		},
	);
	terminal.start(
		text => child.terminal!.write(text),
		() => {},
	);
	const screen = () => terminal.getViewport().join("\n");
	const wait = async (predicate: () => boolean, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!predicate()) {
			if (Date.now() >= deadline || child.exitCode !== null)
				throw new Error(`${label}: ${screen()}\n${output.slice(-500)}`);
			await Bun.sleep(20);
		}
	};
	return {
		screen,
		wait,
		send: (text: string) => child.terminal!.write(text),
		ready: () => wait(() => output.includes("输入已就绪"), "input ready"),
		idle: () => terminal.getViewport()[0]?.includes("就绪") === true,
		async capture(name: string) {
			if (process.env.MY_AGENT_ACCEPTANCE_OUTPUT)
				await Bun.write(path.join(process.env.MY_AGENT_ACCEPTANCE_OUTPUT, `${name}.txt`), screen());
		},
		async quit() {
			child.terminal!.write("/quit\r");
			expect(await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout")])).toBe(0);
		},
		async close() {
			if (child.exitCode === null) child.kill();
			await child.exited;
			child.terminal?.close();
			terminal.stop();
		},
	};
}

test.skipIf(process.platform === "win32")(
	"real terminal grants a disabled preset tool once or for the run and revokes it without changing the preset",
	async () => {
		const f = await fixture();
		const presetFile = path.join(f.home, "presets/limited/preset.json");
		const presetText = JSON.stringify({ ...builtinPreset("bare"), id: "limited", name: "limited", tools: ["read"] });
		await Bun.write(presetFile, presetText);
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		f.respond(request => {
			const index = request.messages.findLastIndex(message => message.role === "user");
			if (request.messages.slice(index + 1).some(message => message.role === "tool"))
				return { text: "TOOL_ACCESS_DONE" };
			const task = JSON.stringify(request.messages[index]?.content);
			const name = task.includes("ONCE")
				? "once"
				: task.includes("RUN")
					? "run"
					: task.includes("REVOKED")
						? "revoked"
						: "direct";
			const args = { path: `${name}.txt`, content: `PTY_${name.toUpperCase()}` };
			return name === "once" || name === "run"
				? {
						call: {
							name: "request_tool",
							arguments: { tool: "write", reason: "保存用户要求的项目记录", arguments: args },
						},
					}
				: { call: { name: "write", arguments: args } };
		});
		const ui = openTerminal(f.home, f.cwd, ["--preset", "limited"]);
		try {
			await ui.ready();
			ui.send("ONCE\r");
			await ui.wait(
				() => ui.screen().includes("临时工具申请") && ui.screen().includes("仅此次调用"),
				"once capability approval",
			);
			expect(await Bun.file(path.join(f.cwd, "once.txt")).exists()).toBe(false);
			ui.send("\x1b[B\x1b[B\x1b[B\r");
			await ui.wait(() => ui.screen().includes("临时工具申请详情"), "capability details");
			expect(await Bun.file(path.join(f.cwd, "once.txt")).exists()).toBe(false);
			ui.send("\x1b");
			await ui.wait(
				() => ui.screen().includes("查看申请详情（只读）") && !ui.screen().includes("临时工具申请详情 ·"),
				"return from capability details",
			);
			ui.send("\r");
			await ui.wait(
				() => ui.screen().includes("创建新文件") && ui.screen().includes("仅本次允许"),
				"original write approval after once",
			);
			ui.send("\r");
			await ui.wait(() => f.requests.length === 2 && ui.idle(), "once write finished");
			expect(await Bun.file(path.join(f.cwd, "once.txt")).text()).toBe("PTY_ONCE");
			expect(f.requests.at(-1)?.tools?.some(tool => tool.function.name === "write")).toBe(false);
			ui.send("RUN\r");
			await ui.wait(
				() => ui.screen().includes("临时工具申请") && ui.screen().includes("本次Agent运行有效"),
				"run capability approval",
			);
			ui.send("\x1b[B\r");
			await ui.wait(
				() => ui.screen().includes("创建新文件") && ui.screen().includes("仅本次允许"),
				"original write approval after run",
			);
			ui.send("\r");
			await ui.wait(() => f.requests.length === 4 && ui.idle(), "run write finished");
			expect(await Bun.file(path.join(f.cwd, "run.txt")).text()).toBe("PTY_RUN");
			expect(f.requests.at(-1)?.tools?.some(tool => tool.function.name === "write")).toBe(true);
			ui.send("DIRECT\r");
			await ui.wait(
				() => ui.screen().includes("创建新文件") && ui.screen().includes("仅本次允许"),
				"direct write still needs operation approval",
			);
			ui.send("\r");
			await ui.wait(() => f.requests.length === 6 && ui.idle(), "direct run-authorized write finished");
			expect(await Bun.file(path.join(f.cwd, "direct.txt")).text()).toBe("PTY_DIRECT");
			ui.send("/tools revoke write\r");
			await ui.wait(
				() => ui.screen().includes("撤销临时授权") && ui.screen().includes("取消"),
				"revoke confirmation",
			);
			ui.send("\r");
			await ui.wait(() => ui.screen().includes("已撤销") && ui.idle(), "revoked run grant");
			ui.send("REVOKED\r");
			await ui.wait(() => f.requests.length === 8 && ui.idle(), "fabricated write after revoke rejected");
			expect(await Bun.file(path.join(f.cwd, "revoked.txt")).exists()).toBe(false);
			expect(f.requests.at(-1)?.tools?.some(tool => tool.function.name === "write")).toBe(false);
			ui.send("/tools list\r");
			await ui.wait(
				() => ui.screen().includes("工具状态 · 只读") && ui.screen().includes("关闭 · write"),
				"readable status after revoke",
			);
			await ui.capture("temporary-tools-revoked");
			ui.send("\x1b");
			await ui.wait(() => ui.idle(), "status closed");
			expect(await Bun.file(presetFile).text()).toBe(presetText);
			await ui.quit();
		} finally {
			await ui.close();
			await f.close();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"real Ink approval details return without granting, while create/overwrite/late edit remain explicit",
	async () => {
		const f = await fixture();
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const before = `${"unchanged context\n".repeat(100)}OLD_LATE\n`;
		const after = `${"unchanged context\n".repeat(100)}NEW_LATE\n`;
		await Bun.write(path.join(f.cwd, "long.txt"), before);
		f.respond(request => {
			const index = request.messages.findLastIndex(message => message.role === "user");
			if (request.messages.slice(index + 1).some(message => message.role === "tool"))
				return { text: "APPROVAL_DONE" };
			const text = JSON.stringify(request.messages[index]?.content);
			return text.includes("LATE_EDIT")
				? { call: { name: "edit", arguments: { path: "long.txt", old_string: before, new_string: after } } }
				: {
						call: {
							name: "write",
							arguments: {
								path: "created.txt",
								content: text.includes("OVERWRITE") ? "OVERWRITE_NEW\n" : "CREATE_NEW\n",
							},
						},
					};
		});
		const ui = openTerminal(f.home, f.cwd);
		try {
			await ui.ready();
			ui.send("DENY_CREATE\r");
			await ui.wait(
				() => ui.screen().includes("创建新文件") && ui.screen().includes("仅本次允许"),
				"create approval",
			);
			ui.send("\x1b[B\x1b[B\x1b[B\r");
			await ui.wait(() => ui.screen().includes("修改预览 · 返回后仍需批准"), "read-only details");
			await ui.capture("approval-details");
			expect(await Bun.file(path.join(f.cwd, "created.txt")).exists()).toBe(false);
			ui.send("\x1b");
			await ui.wait(() => ui.screen().includes("仅本次允许"), "return to decision");
			expect(await Bun.file(path.join(f.cwd, "created.txt")).exists()).toBe(false);
			ui.send("\x1b[B\x1b[B\r");
			await ui.wait(() => f.requests.length === 2 && ui.idle(), "rejected create completes");
			expect(await Bun.file(path.join(f.cwd, "created.txt")).exists()).toBe(false);
			ui.send("ALLOW_CREATE\r");
			await ui.wait(() => ui.screen().includes("创建新文件") && ui.screen().includes("仅本次允许"), "allow create");
			ui.send("\r");
			await ui.wait(() => f.requests.length === 4 && ui.idle(), "created");
			expect(await Bun.file(path.join(f.cwd, "created.txt")).text()).toBe("CREATE_NEW\n");
			ui.send("OVERWRITE\r");
			await ui.wait(
				() =>
					ui.screen().includes("覆盖现有文件") &&
					ui.screen().includes("-CREATE_NEW") &&
					ui.screen().includes("+OVERWRITE_NEW"),
				"overwrite diff",
			);
			await ui.capture("approval-overwrite");
			ui.send("\r");
			await ui.wait(() => f.requests.length === 6 && ui.idle(), "overwritten");
			expect(await Bun.file(path.join(f.cwd, "created.txt")).text()).toBe("OVERWRITE_NEW\n");
			ui.send("LATE_EDIT\r");
			await ui.wait(() => ui.screen().includes("-OLD_LATE") && ui.screen().includes("+NEW_LATE"), "late edit diff");
			await ui.capture("approval-late-edit");
			ui.send("\x1b");
			await ui.wait(() => f.requests.length === 8 && ui.idle(), "cancelled edit");
			expect(await Bun.file(path.join(f.cwd, "long.txt")).text()).toBe(before);
			await ui.quit();
		} finally {
			await ui.close();
			await f.close();
		}
	},
	45_000,
);

test.skipIf(process.platform === "win32")(
	"real launcher A/B/A cold resume expands only the chosen dollar skill and restores its own history",
	async () => {
		const f = await fixture();
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		for (const id of ["a", "b"]) {
			await Bun.write(path.join(f.cwd, `${id}.md`), `PTY_RULE_ONLY_${id.toUpperCase()}`);
			await Bun.write(
				path.join(f.cwd, `skill-${id}/SKILL.md`),
				`---\nname: preset-${id}\ndescription: Terminal skill ${id}\n---\nPTY_SKILL_BODY_ONLY_${id.toUpperCase()}\n`,
			);
			await Bun.write(
				path.join(f.home, `presets/${id}/preset.json`),
				JSON.stringify({
					...builtinPreset("bare"),
					id,
					name: id,
					tools: ["read"],
					resources: {
						instructions: [{ base: "workspace", path: `${id}.md` }],
						skills: [{ base: "workspace", path: `skill-${id}/SKILL.md` }],
						appendSystem: [],
					},
				}),
			);
		}
		f.respond(request => {
			const text = JSON.stringify(request.messages.findLast(message => message.role === "user")?.content);
			return {
				text: text.includes("PTY_A_RESUME") ? "A_RESUME_DONE" : text.includes("PTY_B") ? "B_DONE" : "A_DONE",
			};
		});
		let aSession: string | undefined;
		try {
			for (const [id, prompt, reply] of [
				["a", "$preset-a PTY_A", "A_DONE"],
				["b", "$preset-b PTY_B", "B_DONE"],
				["a", "PTY_A_RESUME", "A_RESUME_DONE"],
			] as const) {
				const requestCount = f.requests.length;
				const args = ["--preset", id, ...(aSession && id === "a" ? ["--resume", aSession] : [])];
				const ui = openTerminal(f.home, f.cwd, args);
				try {
					await ui.ready();
					ui.send(`${prompt}\r`);
					await ui.wait(
						() => f.requests.length === requestCount + 1 && ui.idle() && ui.screen().includes(reply),
						`${id} reply`,
					);
					await ui.capture(`preset-${id}-${requestCount}`);
					await ui.quit();
				} finally {
					await ui.close();
				}
				if (!aSession) {
					const directory = path.join(f.home, "presets/a/sessions");
					const files = (await fs.readdir(directory)).filter(file => file.endsWith(".jsonl"));
					expect(files).toHaveLength(1);
					aSession = path.join(directory, files[0]!);
				}
			}
			expect(JSON.stringify(f.requests[0])).toContain("PTY_RULE_ONLY_A");
			expect(JSON.stringify(f.requests[0])).toContain("PTY_SKILL_BODY_ONLY_A");
			expect(JSON.stringify(f.requests[1])).toContain("PTY_RULE_ONLY_B");
			expect(JSON.stringify(f.requests[1])).toContain("PTY_SKILL_BODY_ONLY_B");
			expect(JSON.stringify(f.requests[1])).not.toMatch(/PTY_RULE_ONLY_A|PTY_SKILL_BODY_ONLY_A|PTY_A/);
			expect(JSON.stringify(f.requests[2])).toContain("PTY_SKILL_BODY_ONLY_A");
			expect(JSON.stringify(f.requests[2])).not.toMatch(/PTY_RULE_ONLY_B|PTY_SKILL_BODY_ONLY_B|PTY_B/);
			expect(f.requestHeaders[2]?.sessionId).toBe(f.requestHeaders[0]?.sessionId);
			expect(f.requestHeaders[1]?.sessionId).not.toBe(f.requestHeaders[0]?.sessionId);
		} finally {
			await f.close();
		}
	},
	45_000,
);

const sandboxTest = process.env.MY_AGENT_SANDBOX_TEST === "1" && process.platform === "darwin" ? test : test.skip;
sandboxTest(
	"real Ink sandbox results expand long logs, retain nonzero exit and stop a background job",
	async () => {
		const f = await fixture();
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		let runningId = "";
		let runningPid = 0;
		f.respond(request => {
			const index = request.messages.findLastIndex(message => message.role === "user");
			const results = request.messages.slice(index + 1).filter(message => message.role === "tool");
			if (results.length) return { text: "COMMAND_DONE" };
			const text = JSON.stringify(request.messages[index]?.content);
			return text.includes("STOP_TASK")
				? { call: { name: "job_stop", arguments: { id: runningId } } }
				: {
						call: {
							name: "bash",
							arguments: text.includes("BACKGROUND_TASK")
								? { command: "sleep 30", background: true }
								: {
										command:
											"printf 'START_OF_OUTPUT\\n'; for i in {1..140}; do printf 'progress-%03d\\n' \"$i\"; done; printf 'FINAL_FAILURE\\n'; exit 7",
									},
						},
					};
		});
		const ui = openTerminal(f.home, f.cwd);
		try {
			await ui.ready();
			ui.send("LONG_OUTPUT_TASK\r");
			await ui.wait(() => ui.screen().includes("仅本次允许"), "command approval");
			ui.send("\r");
			await ui.wait(() => f.requests.length === 2 && ui.idle(), "foreground result");
			expect(ui.screen()).toContain("退出码 7");
			expect(ui.screen()).toContain("FINAL_FAILURE");
			await ui.capture("command-collapsed");
			const collapsed = (ui.screen().match(/progress-\d{3}/g) ?? []).length;
			ui.send("\x0f");
			await ui.wait(() => (ui.screen().match(/progress-\d{3}/g) ?? []).length > collapsed + 5, "expanded log");
			await ui.capture("command-expanded");
			ui.send("\x0f");
			ui.send("BACKGROUND_TASK\r");
			await ui.wait(() => ui.screen().includes("仅本次允许"), "background approval");
			ui.send("\r");
			await ui.wait(() => f.requests.length === 4 && ui.idle(), "background result");
			const result = JSON.parse(
				String(f.requests.at(-1)!.messages.findLast(message => message.role === "tool")!.content),
			) as { id: string; pid: number; status: string };
			expect(result.status).toBe("running");
			runningId = result.id;
			runningPid = result.pid;
			ui.send("STOP_TASK\r");
			await ui.wait(() => f.requests.length === 6 && ui.idle(), "stopped result");
			expect(ui.screen()).toContain("已取消");
			expect(() => process.kill(runningPid, 0)).toThrow();
			await ui.capture("command-background-stopped");
			await ui.quit();
		} finally {
			await ui.close();
			await f.close();
		}
	},
	45_000,
);

const macPresetTest = process.platform === "darwin" ? test : test.skip;
const down = (count: number) => "\x1b[B".repeat(count);

macPresetTest(
	"real Mac Ink preset editor cancels drafts, saves after preview and binds only the next launch",
	async () => {
		const f = await fixture();
		const configFile = path.join(f.home, "config.json");
		await Bun.write(configFile, JSON.stringify(f.config));
		const configBefore = await Bun.file(configFile).text();
		let ui = openTerminal(f.home, f.cwd, ["--preset", "bare"]);
		try {
			await ui.ready();
			ui.send("/preset create cancelled\r");
			await ui.wait(() => ui.screen().includes("选择起始模板"), "new cancelled template");
			ui.send(`${down(3)}\r`);
			await ui.wait(() => ui.screen().includes("编辑预设 cancelled"), "cancelled draft");
			ui.send("\x1b");
			await ui.wait(() => !ui.screen().includes("编辑预设 cancelled"), "draft cancelled");
			expect(await Bun.file(path.join(f.home, "presets/cancelled/preset.json")).exists()).toBe(false);
			ui.send("/preset create edited\r");
			await ui.wait(() => ui.screen().includes("选择起始模板"), "new saved template");
			ui.send(`${down(2)}\r`);
			await ui.wait(() => ui.screen().includes("编辑预设 edited"), "editable draft");
			ui.send("\r");
			await ui.wait(() => ui.screen().includes("预设显示名称"), "name input");
			ui.send("Mac saved preset\r");
			await ui.wait(() => ui.screen().includes("编辑预设 edited"), "name changed");
			ui.send(`${down(10)}\r`);
			await ui.wait(() => ui.screen().includes("预设差异"), "save preview");
			expect(await Bun.file(path.join(f.home, "presets/edited/preset.json")).exists()).toBe(false);
			ui.send("\x1b");
			await ui.wait(() => ui.screen().includes("保存预设？"), "explicit save decision");
			ui.send("\r");
			await ui.wait(() => ui.screen().includes("预设已保存"), "saved draft");
			const saved = await Bun.file(path.join(f.home, "presets/edited/preset.json")).json();
			expect(saved.name).toBe("Mac saved preset");
			ui.send("/preset edit edited\r");
			await ui.wait(() => ui.screen().includes("编辑预设 edited"), "edit existing");
			ui.send("\r");
			await ui.wait(() => ui.screen().includes("预设显示名称"), "existing name input");
			ui.send("Discard this name\r");
			await ui.wait(() => ui.screen().includes("编辑预设 edited"), "unsaved existing edit");
			ui.send("\x1b");
			await ui.wait(() => !ui.screen().includes("编辑预设 edited"), "existing edit cancelled");
			expect(await Bun.file(path.join(f.home, "presets/edited/preset.json")).json()).toEqual(saved);
			ui.send("/preset bind edited\r");
			await ui.wait(() => ui.screen().includes("已设置下次启动默认：edited"), "bound default");
			expect(ui.screen()).toContain("预设 bare ·");
			await ui.capture("mac-preset-editor-bound");
			await ui.quit();
			await ui.close();
			ui = openTerminal(f.home, f.cwd);
			await ui.ready();
			expect(ui.screen()).toContain("预设 edited ·");
			ui.send("DEFAULT_LAUNCH\r");
			await ui.wait(() => f.requests.length === 1 && ui.idle(), "default preset model reply");
			await ui.quit();
			expect(await Bun.file(configFile).text()).toBe(configBefore);
			expect(f.requests[0]?.tools).toBeUndefined();
			expect(
				(await fs.readdir(path.join(f.home, "presets/edited/sessions"))).filter(file => file.endsWith(".jsonl")),
			).toHaveLength(1);
		} finally {
			await ui.close();
			await f.close();
		}
	},
	60_000,
);

macPresetTest(
	"real Mac Ink same-terminal A/B/resume A isolates resources, tools, history, journals and resets full grants",
	async () => {
		const f = await fixture();
		f.config.model.key = "coding";
		f.config.models = [{ ...f.config.model, key: "review" }];
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const configBefore = await Bun.file(path.join(f.home, "config.json")).text();
		for (const id of ["a", "b"]) {
			await Bun.write(path.join(f.cwd, `${id}.md`), `MAC_RULE_${id.toUpperCase()}_ONLY`);
			await Bun.write(
				path.join(f.home, `presets/${id}/preset.json`),
				JSON.stringify({
					...builtinPreset("bare"),
					id,
					name: id,
					tools: id === "a" ? ["read", "write"] : ["read", "ls"],
					model: { default: "coding", allowed: id === "a" ? ["coding", "review"] : ["coding"] },
					resources: { instructions: [{ base: "workspace", path: `${id}.md` }], skills: [], appendSystem: [] },
				}),
			);
		}
		f.respond(request => {
			const last = request.messages.findLastIndex(message => message.role === "user");
			const user = JSON.stringify(request.messages[last]?.content);
			if (user.includes("MAC_A_WRITE") && !request.messages.slice(last + 1).some(message => message.role === "tool"))
				return { call: { name: "write", arguments: { path: "a-only.txt", content: "A_LOCAL_FILE\n" } } };
			if (
				user.includes("MAC_DENIED_FULL") &&
				!request.messages.slice(last + 1).some(message => message.role === "tool")
			)
				return { call: { name: "write", arguments: { path: "../full-only.txt", content: "MUST_NOT_WRITE\n" } } };
			return {
				text: user.includes("MAC_A_RESUME")
					? "MAC_A_RESUMED"
					: user.includes("MAC_B")
						? "MAC_B_DONE"
						: "MAC_A_DONE",
			};
		});
		const ui = openTerminal(f.home, f.cwd, ["--preset", "a"]);
		try {
			await ui.ready();
			ui.send("/model review max\r");
			await ui.wait(() => ui.screen().includes("本会话模型已切换：review"), "A connection and effort changed");
			ui.send("/permissions full\r");
			await ui.wait(() => ui.screen().includes("本会话已完整授权"), "isolated full grant");
			ui.send("MAC_A_WRITE PRIVATE_A_HISTORY\r");
			await ui.wait(() => f.requests.length === 2 && ui.idle(), "A file-only full turn");
			expect(await Bun.file(path.join(f.cwd, "a-only.txt")).text()).toBe("A_LOCAL_FILE\n");
			const aId = f.requestHeaders[0]!.sessionId!;
			ui.send("/plan\r");
			await ui.wait(() => ui.screen().includes("计划模式：禁止写入"), "A plan on");
			ui.send("/preset use b --new\r");
			await ui.wait(() => ui.screen().includes("预设 b ·") && ui.idle(), "same terminal B activated");
			expect(ui.screen()).toContain("手动授权");
			expect(ui.screen()).toContain("计划");
			ui.send("MAC_B PRIVATE_B_HISTORY\r");
			await ui.wait(() => f.requests.length === 3 && ui.idle(), "B isolated turn");
			const bId = f.requestHeaders[2]!.sessionId!;
			expect(bId).not.toBe(aId);
			ui.send(`/resume ${aId}\r`);
			await ui.wait(() => ui.screen().includes("预设 a ·") && ui.idle(), "same terminal A resumed");
			expect(ui.screen()).toContain("手动授权");
			expect(ui.screen()).toContain("计划");
			expect(ui.screen()).toContain("· review");
			ui.send("MAC_A_RESUME\r");
			await ui.wait(() => f.requests.length === 4 && ui.idle(), "resumed A turn");
			await ui.capture("mac-same-terminal-a-resumed");
			expect(f.requestHeaders[3]?.sessionId).toBe(aId);
			expect(f.requests[3]?.model).toBe(f.config.model.id);
			const wire: { reasoning_effort?: string } = JSON.parse(JSON.stringify(f.requests[3]));
			expect(wire.reasoning_effort).toBe("max");
			const bRequest = JSON.stringify(f.requests[2]);
			const resumed = JSON.stringify(f.requests[3]);
			expect(bRequest).toContain("MAC_RULE_B_ONLY");
			expect(bRequest).not.toMatch(/MAC_RULE_A_ONLY|PRIVATE_A_HISTORY/);
			expect(resumed).toContain("MAC_RULE_A_ONLY");
			expect(resumed).toContain("PRIVATE_A_HISTORY");
			expect(resumed).not.toMatch(/MAC_RULE_B_ONLY|PRIVATE_B_HISTORY/);
			expect(f.requests[2]?.tools?.map(tool => tool.function.name).sort()).toEqual(["ls", "read", "request_tool"]);
			expect(f.requests[3]?.tools?.map(tool => tool.function.name).sort()).toEqual([
				"read",
				"request_tool",
				"write",
			]);
			ui.send("/plan\r");
			await ui.wait(() => ui.screen().includes("已进入执行模式"), "resume execution to check reset full scope");
			ui.send("MAC_DENIED_FULL\r");
			await ui.wait(
				() => f.requests.length === 6 && ui.idle(),
				"resumed A rejects out-of-workspace full-only write",
			);
			expect(JSON.stringify(f.requests[5]?.messages.filter(message => message.role === "tool"))).toContain(
				"目标超出工作区或允许范围",
			);
			expect(await Bun.file(path.join(f.root, "full-only.txt")).exists()).toBe(false);
			ui.send("/plan\r");
			await ui.wait(() => ui.screen().includes("预设 a · 计划 · 手动授权"), "restore tested plan state");
			await ui.quit();
			expect(await Bun.file(path.join(f.home, "config.json")).text()).toBe(configBefore);
			for (const [id, key] of [
				[aId, "review"],
				[bId, "coding"],
			]) {
				const manifest = await Bun.file(path.join(f.home, "state", id!, "manifest.json")).json();
				expect(manifest.runtime.model.model).toBe(key);
				expect(manifest.runtime.plan).toBe(true);
				expect(JSON.stringify(manifest.runtime)).not.toContain("full");
				if (id === aId) expect(manifest.runtime.model.effort).toBe("max");
			}
			const aFiles = (await fs.readdir(path.join(f.home, "presets/a/sessions"))).filter(file =>
				file.endsWith(".jsonl"),
			);
			const bFiles = (await fs.readdir(path.join(f.home, "presets/b/sessions"))).filter(file =>
				file.endsWith(".jsonl"),
			);
			expect(aFiles).toHaveLength(1);
			expect(bFiles).toHaveLength(1);
			expect(await Bun.file(path.join(f.home, "presets/a/sessions", aFiles[0]!)).text()).not.toContain(
				"PRIVATE_B_HISTORY",
			);
			expect(await Bun.file(path.join(f.home, "presets/b/sessions", bFiles[0]!)).text()).not.toContain(
				"PRIVATE_A_HISTORY",
			);
			const aJournal = await JournalStore.open(path.join(f.home, "state", aId));
			const bJournal = await JournalStore.open(path.join(f.home, "state", bId));
			try {
				expect(aJournal.list().map(change => path.basename(change.path))).toEqual(["a-only.txt"]);
				expect(bJournal.list()).toEqual([]);
			} finally {
				aJournal.close();
				bJournal.close();
			}
		} finally {
			await ui.close();
			await f.close();
		}
	},
	60_000,
);

macPresetTest(
	"real Mac Ink preparation cancellation and invalid target preserve the source and existing target bytes",
	async () => {
		const f = await fixture();
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const rule = path.join(f.cwd, "target.md");
		await Bun.write(rule, "MAC_TARGET_RULE");
		await Bun.write(
			path.join(f.home, "presets/target/preset.json"),
			JSON.stringify({
				...builtinPreset("bare"),
				id: "target",
				name: "target",
				tools: ["read"],
				resources: { instructions: [{ base: "workspace", path: "target.md" }], skills: [], appendSystem: [] },
			}),
		);
		let ui = openTerminal(f.home, f.cwd, ["--preset", "target"]);
		let locked: Database | undefined;
		try {
			await ui.ready();
			ui.send("PRIVATE_TARGET_HISTORY\r");
			await ui.wait(() => f.requests.length === 1 && ui.idle(), "seed target history");
			const targetId = f.requestHeaders[0]!.sessionId!;
			await ui.quit();
			await ui.close();
			const sessions = path.join(f.home, "presets/target/sessions");
			const targetFile = path.join(
				sessions,
				(await fs.readdir(sessions)).find(file => file.endsWith(".jsonl"))!,
			);
			const targetManifest = path.join(f.home, "state", targetId, "manifest.json");
			const transcriptBefore = await Bun.file(targetFile).text();
			const manifestBefore = await Bun.file(targetManifest).text();
			locked = new Database(path.join(f.home, "state", targetId, "changes.sqlite"));
			locked.run("BEGIN EXCLUSIVE");
			ui = openTerminal(f.home, f.cwd, ["--preset", "bare"]);
			await ui.ready();
			ui.send("PRIVATE_SOURCE_HISTORY\r");
			await ui.wait(() => f.requests.length === 2 && ui.idle(), "source turn");
			const sourceId = f.requestHeaders[1]!.sessionId!;
			ui.send(`/resume ${targetId}\r`);
			await ui.wait(() => ui.screen().includes("正在准备预设，输入已冻结"), "target preparation frozen");
			const storage = new FileSessionStorage();
			await ui.wait(() => {
				const lease = storage.claimSession(targetId, targetFile);
				if (!lease) return true;
				lease();
				return false;
			}, "prepared target owns its session before blocked SQLite initialization");
			expect(f.requests).toHaveLength(2);
			ui.send("\x1b");
			await ui.wait(() => ui.screen().includes("交接已取消，原会话保留"), "preparation cancelled");
			locked.run("ROLLBACK");
			locked.close();
			locked = undefined;
			expect(await Bun.file(targetFile).text()).toBe(transcriptBefore);
			expect(await Bun.file(targetManifest).text()).toBe(manifestBefore);
			expect((await fs.readdir(sessions)).filter(file => file.endsWith(".jsonl"))).toEqual([
				path.basename(targetFile),
			]);
			ui.send("AFTER_CANCEL\r");
			await ui.wait(() => f.requests.length === 3 && ui.idle(), "source answers after cancellation");
			expect(f.requestHeaders[2]?.sessionId).toBe(sourceId);
			expect(JSON.stringify(f.requests[2])).toContain("PRIVATE_SOURCE_HISTORY");
			expect(JSON.stringify(f.requests[2])).not.toContain("PRIVATE_TARGET_HISTORY");
			await fs.unlink(rule);
			ui.send(`/resume ${targetId}\r`);
			await ui.wait(
				// The preparing child writes raw ENOENT to shared stderr before its failed IPC.
				// Only the source's Error notification follows release of the frozen input.
				() => ui.screen().includes("Error: ENOENT") && ui.idle(),
				"source reports target compilation failure after releasing frozen input",
			);
			expect(await Bun.file(targetFile).text()).toBe(transcriptBefore);
			expect(await Bun.file(targetManifest).text()).toBe(manifestBefore);
			ui.send("AFTER_TARGET_FAILURE");
			await ui.wait(
				() =>
					ui
						.screen()
						.split("\n")
						.some(line => line.includes("› AFTER_TARGET_FAILURE")),
				"source editor accepts the exact post-failure draft",
			);
			ui.send("\r");
			await ui.wait(() => f.requests.length === 4 && ui.idle(), "source answers after target rejection");
			expect(f.requestHeaders[3]?.sessionId).toBe(sourceId);
			expect(f.requests[3]?.messages.findLast(message => message.role === "user")?.content).toEqual([
				{ type: "text", text: "AFTER_TARGET_FAILURE" },
			]);
			expect(ui.screen()).toContain("预设 bare ·");
			await ui.capture("mac-preparation-cancel-target-failure");
			await ui.quit();
		} finally {
			locked?.close();
			await ui.close();
			await f.close();
		}
	},
	60_000,
);

macPresetTest(
	"real Mac Ink handoff has closed an approved local HTTP MCP connection by the time the next preset is ready",
	async () => {
		const f = await fixture();
		const methods: string[] = [];
		let closed = 0;
		const remote = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					closed++;
					return new Response(null, { status: 200 });
				}
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const body = (await request.json()) as { method: string; id?: number | string };
				methods.push(body.method);
				if (body.id === undefined) return new Response(null, { status: 202 });
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-11-25",
								serverInfo: { name: "mac-local", version: "1" },
								capabilities: { tools: {} },
							}
						: { tools: [] };
				return Response.json(
					{ jsonrpc: "2.0", id: body.id, result },
					{ headers: { "Mcp-Session-Id": "mac-local-session" } },
				);
			},
		});
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { local: { type: "http", url: `http://127.0.0.1:${remote.port}/mcp` } };
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		await Bun.write(
			path.join(f.home, "presets/mcp-a/preset.json"),
			JSON.stringify({
				...builtinPreset("bare"),
				id: "mcp-a",
				name: "mcp-a",
				tools: ["mcp_list", "mcp_call"],
				mcpServers: ["local"],
			}),
		);
		const ui = openTerminal(f.home, f.cwd, ["--preset", "mcp-a"]);
		try {
			await ui.ready();
			expect(methods).toEqual([]);
			ui.send("/mcp\r");
			await ui.wait(() => ui.screen().includes("MCP 外部工具"), "MCP menu");
			ui.send(`${down(1)}\r`);
			await ui.wait(() => ui.screen().includes("当前会话中的服务"), "MCP server picker");
			ui.send("\r");
			await ui.wait(() => ui.screen().includes("仅本次允许"), "explicit local MCP approval");
			expect(methods).toEqual([]);
			ui.send("\r");
			await ui.wait(
				() => methods.includes("tools/list") && ui.screen().includes("MCP 工具及参数"),
				"MCP connected tools",
			);
			expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
			ui.send("\x1b");
			await ui.wait(() => !ui.screen().includes("MCP 工具及参数"), "MCP tool view closed");
			ui.send("/preset use chat --new\r");
			await ui.wait(() => ui.screen().includes("预设 chat ·") && ui.idle(), "MCP-free chat active");
			expect(closed).toBe(1);
			expect(f.requests).toEqual([]);
			await ui.capture("mac-mcp-closed-on-handoff");
			await ui.quit();
			expect(closed).toBe(1);
		} finally {
			await ui.close();
			remote.stop(true);
			await f.close();
		}
	},
	60_000,
);
