import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fixture, HOST_TEST_TIMEOUT } from "./helpers";
import { newPresetDraft, savePresetDraft } from "../src/presets/store";
import { setPresetDefault } from "../src/presets/defaults";

test(
	"real launcher manages presets without importing SDK, making model calls or changing shared config",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "preset-launcher-"));
		const launcher = path.resolve(import.meta.dir, "../src/launcher.ts");
		const run = async (args: string[]) => {
			const child = Bun.spawn(
				[process.execPath, "--no-env-file", launcher, "--home", root, "--cwd", root, ...args],
				{
					stdout: "pipe",
					stderr: "pipe",
					signal: AbortSignal.timeout(process.platform === "win32" ? 90_000 : 20_000),
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
					},
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, code };
		};
		try {
			const listed = await run(["preset", "list"]);
			expect(listed.code, listed.stderr).toBe(0);
			expect(JSON.parse(listed.stdout).presets.map((item: { id: string }) => item.id)).toEqual([
				"legacy",
				"chat",
				"bare",
			]);
			expect(await Bun.file(path.join(root, "config.json")).exists()).toBe(false);
			const created = await run(["preset", "create", "work", "--template", "coding"]);
			expect(created.code, created.stderr).toBe(0);
			const file = path.join(root, "presets", "work", "preset.json");
			const original = await Bun.file(file).text();
			expect((await run(["preset", "create", "work"])).code).not.toBe(0);
			expect(await Bun.file(file).text()).toBe(original);
			const conflict = await run(["--preset", "chat", "--light"]);
			expect(conflict.code).not.toBe(0);
			expect(conflict.stderr).toContain("不能同时使用");
			const missing = await run(["--preset", "missing"]);
			expect(missing.code).not.toBe(0);
			expect(missing.stderr).toContain("预设不存在");
			const restore = await run(["--preset", "chat", "restore-config"]);
			expect(restore.code).not.toBe(0);
			expect(restore.stderr).toContain("共享配置管理");
			const prompt = await run(["--preset", "missing", "--prompt", "preset"]);
			expect(prompt.code).not.toBe(0);
			expect(prompt.stderr).toContain("预设不存在");
			expect(await Bun.file(path.join(root, "config.json")).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"real launcher applies defaults before SDK import and restores the original preset after rebinding",
	async () => {
		const f = await fixture();
		const launcher = path.resolve(import.meta.dir, "../src/launcher.ts");
		const run = async (args: string[], prompt: string) => {
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					launcher,
					"--home",
					f.home,
					"--cwd",
					f.cwd,
					"--print",
					"--prompt",
					prompt,
					...args,
				],
				{
					cwd: f.cwd,
					stdout: "pipe",
					stderr: "pipe",
					signal: AbortSignal.timeout(process.platform === "win32" ? 120_000 : 30_000),
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						USERPROFILE: process.env.USERPROFILE,
						LOCALAPPDATA: process.env.LOCALAPPDATA,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						TERM: "dumb",
						PRODUCT_TEST_KEY: "local-fixture-key",
					},
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, stderr).toBe(0);
			expect(stdout).toContain("LOCAL_PRODUCT_OK");
		};
		try {
			await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
			await Bun.write(path.join(f.cwd, "work.md"), "RULE_ONLY_FOR_BOUND_WORK");
			const draft = newPresetDraft("work");
			draft.definition.tools = ["read"];
			draft.definition.resources.instructions = [{ base: "workspace", path: "work.md" }];
			await savePresetDraft(f.home, f.cwd, draft);
			await setPresetDefault(f.home, f.cwd, "global", "bare");
			await setPresetDefault(f.home, f.cwd, "workspace", "work");
			await run([], "FIRST_BOUND_SESSION");
			expect(f.requests).toHaveLength(1);
			expect(JSON.stringify(f.requests[0])).toContain("RULE_ONLY_FOR_BOUND_WORK");
			expect(f.requests[0].tools?.map(tool => tool.function.name)).toEqual(["read", "request_tool"]);
			const directory = path.join(f.home, "presets/work/sessions");
			const sessions = (await fs.readdir(directory)).filter(file => file.endsWith(".jsonl"));
			expect(sessions).toHaveLength(1);
			const sessionFile = path.join(directory, sessions[0]);
			await setPresetDefault(f.home, f.cwd, "workspace", "chat");
			await run(["--resume", sessionFile], "RESTORED_ORIGINAL_PRESET");
			expect(f.requests).toHaveLength(2);
			expect(JSON.stringify(f.requests[1])).toContain("RULE_ONLY_FOR_BOUND_WORK");
			expect(JSON.stringify(f.requests[1])).toContain("FIRST_BOUND_SESSION");
			expect(await Bun.file(sessionFile).text()).toContain("RESTORED_ORIGINAL_PRESET");
			await run(["--preset", "bare"], "EXPLICIT_BARE_OVERRIDE");
			expect(f.requests).toHaveLength(3);
			expect(JSON.stringify(f.requests[2])).not.toMatch(/RULE_ONLY_FOR_BOUND_WORK|FIRST_BOUND_SESSION/);
			expect(f.requests[2].tools?.some(tool => tool.function.name === "write")).toBe(true);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);
