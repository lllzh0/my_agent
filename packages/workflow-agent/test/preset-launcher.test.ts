import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("real launcher manages presets without importing SDK, making model calls or changing shared config", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "preset-launcher-"));
	const launcher = path.resolve(import.meta.dir, "../src/launcher.ts");
	const run = async (args: string[]) => {
		const child = Bun.spawn([process.execPath, "--no-env-file", launcher, "--home", root, "--cwd", root, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(20_000),
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
			},
		});
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
}, 30_000);
