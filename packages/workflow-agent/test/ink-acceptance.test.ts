import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { builtinPreset } from "../src/presets/presets";
import { fixture } from "./helpers";

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
