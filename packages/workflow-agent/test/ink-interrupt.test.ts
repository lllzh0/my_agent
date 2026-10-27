// Exercise actual keyboard routing and queue recovery through the product launcher.
import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { fixture } from "./helpers";

for (const control of ["escape", "palette"] as const)
	test.skipIf(process.platform === "win32")(
		`${control} stop restores queued input beside the draft without sending another model request`,
		async () => {
			const f = await fixture();
			f.stallChild();
			await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
			const terminal = new VirtualTerminal(120, 36);
			const decoder = new TextDecoder();
			let output = "";
			const child = Bun.spawn(
				[process.execPath, path.resolve(import.meta.dir, "../src/launcher.ts"), "--home", f.home, "--cwd", f.cwd],
				{
					cwd: f.cwd,
					env: {
						PATH: process.env.PATH,
						HOME: os.homedir(),
						TERM: "xterm-256color",
						PRODUCT_TEST_KEY: "local-key",
					},
					terminal: {
						cols: 120,
						rows: 36,
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
				const deadline = Date.now() + 10000;
				while (!predicate()) {
					if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`${label}: ${screen()}`);
					await Bun.sleep(20);
				}
			};
			const send = (text: string) => child.terminal!.write(text);
			try {
				await wait(() => output.includes("输入已就绪"), "ready");
				send("STALL_CHILD\r");
				await wait(() => f.requests.length === 1 && screen().includes("执行中"), "stream");
				send("QUEUED_TASK\x11");
				await wait(() => screen().includes("排队 1"), "queued");
				send("UNSENT_DRAFT");
				await wait(() => screen().includes("› UNSENT_DRAFT"), "draft");
				if (control === "palette") {
					send("\x10");
					await wait(() => screen().includes("操作面板"), "palette");
					send("停止当前回答\r");
				} else {
					send("\x1b");
				}
				await wait(() => terminal.getViewport()[0]?.includes("就绪") === true, "stopped");
				// Allow the aborted turn's maintenance/queue drain to settle.
				await Bun.sleep(250);
				expect(f.requests).toHaveLength(1);
				expect(screen()).toContain("› QUEUED_TASK");
				expect(screen()).toContain("UNSENT_DRAFT");
				expect(screen()).not.toContain("排队 1");
			} finally {
				child.kill();
				await child.exited;
				child.terminal?.close();
				terminal.stop();
				await f.close();
			}
		},
		30000,
	);
