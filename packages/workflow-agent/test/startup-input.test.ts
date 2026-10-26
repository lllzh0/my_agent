// Real PTY I/O needs real timers: the child reads keys while its modules and UI initialize.
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

for (const scenario of [
	{ name: "cooked-mode command and question", input: "/trace on\rEARLY_QUESTION\r" },
	{ name: "incomplete bracketed paste", input: "\x1b[200~EARLY_QUESTION" },
	{ name: "incomplete escape sequence", input: "\x1b[" },
])
	test.skipIf(process.platform === "win32")(
		`startup ${scenario.name} cannot contaminate the first ready prompt`,
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-startup-"));
			const home = path.join(root, "home");
			let output = "";
			const painted = Promise.withResolvers<void>();
			const replied = Promise.withResolvers<void>();
			const decoder = new TextDecoder();
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../src/launcher.ts"),
					"--demo",
					"--home",
					home,
					"--cwd",
					root,
				],
				{
					cwd: root,
					env: { PATH: process.env.PATH, HOME: os.homedir(), TERM: "xterm-256color", PI_NO_TITLE: "1" },
					terminal: {
						cols: 140,
						rows: 40,
						data(_terminal, data) {
							output += decoder.decode(data, { stream: true });
							if (output.includes("My Agent · 执行")) painted.resolve();
							if (output.includes("离线演示已运行")) replied.resolve();
						},
					},
				},
			);
			const deadline = setTimeout(() => {
				painted.reject(new Error(`TUI did not paint: ${output.slice(-2000)}`));
				replied.reject(new Error("TUI did not answer"));
				child.kill();
			}, 15000);
			// Attach rejection handlers even when startup fails before the second await.
			void replied.promise.catch(() => {});
			try {
				child.terminal!.write(scenario.input);
				await painted.promise;
				await Bun.sleep(250);
				child.terminal!.write("\r");
				await Bun.sleep(100);
				child.terminal!.write("READY_QUESTION\r");
				await replied.promise;
				child.terminal!.write("/quit\r");
				expect(await child.exited).toBe(0);
				expect(output.includes("用法：/trace")).toBe(false);
				const sessions = await fs.readdir(path.join(home, "sessions"));
				const history = await Bun.file(
					path.join(
						home,
						"sessions",
						sessions.find(name => name.endsWith(".jsonl"))!,
					),
				).text();
				expect(history).toContain("READY_QUESTION");
				expect(history).not.toContain("EARLY_QUESTION");
				expect(output).toContain("输入已就绪");
			} finally {
				clearTimeout(deadline);
				child.kill();
				await child.exited;
				child.terminal?.close();
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		20000,
	);
