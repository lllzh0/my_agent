import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const launcher = path.resolve(import.meta.dir, "../src/launcher.ts");

test("the launcher honors MY_AGENT_CWD and gives an explicit cwd flag precedence", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-launcher-cwd-"));
	const environmentWorkspace = path.join(root, "environment-workspace");
	const explicitWorkspace = path.join(root, "explicit-workspace");
	await Promise.all([fs.mkdir(environmentWorkspace), fs.mkdir(explicitWorkspace)]);
	try {
		for (const entry of [
			{ args: [], expected: environmentWorkspace },
			{ args: ["--cwd", explicitWorkspace], expected: explicitWorkspace },
		]) {
			const child = Bun.spawn([process.execPath, launcher, "doctor", ...entry.args], {
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: os.homedir(),
					TERM: "dumb",
					MY_AGENT_HOME: path.join(root, "home"),
					MY_AGENT_CWD: environmentWorkspace,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, stderr).toBe(0);
			const report = JSON.parse(stdout);
			expect(report.cwd).toBe(entry.expected);
			expect(report.runtime.cwd).toBe(await fs.realpath(entry.expected));
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30000);

test("fresh CLI keeps its configuration separate and answers without real model credentials", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-product-cli-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "workspace");
	await fs.mkdir(cwd);
	let connections = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			connections++;
			return new Response("unexpected");
		},
	});
	const run = async (args: string[]) => {
		const child = Bun.spawn([process.execPath, launcher, ...args, "--home", home, "--cwd", cwd], {
			env: { PATH: process.env.PATH, HOME: os.homedir(), TERM: "dumb" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	};
	try {
		const setup = await run(["setup", "--defaults"]);
		expect(setup.code, setup.stderr).toBe(0);
		const config = await Bun.file(path.join(home, "config.json")).json();
		expect(config.model.id).toBe("deepseek-v4.1-flash");
		expect(JSON.stringify(config)).not.toContain('"apiKey":');
		config.mcpServers = {
			selected: { url: `http://127.0.0.1:${server.port}/mcp` },
			disabled: { enabled: false, command: "not-installed" },
			invalid: { type: "sse", url: "https://example.invalid/" },
		};
		await Bun.write(path.join(home, "config.json"), JSON.stringify(config));
		const doctor = await run(["doctor"]);
		expect(doctor.code, doctor.stderr).toBe(0);
		expect(JSON.parse(doctor.stdout).runtime.engine).toBe("bun");
		expect(JSON.parse(doctor.stdout).runtime.cwd).toBe(await fs.realpath(cwd));
		expect(JSON.parse(doctor.stdout).model.credentialAvailable).toBe(false);
		expect(JSON.parse(doctor.stdout).mcp.map((entry: { status: string }) => entry.status)).toEqual([
			"configured",
			"disabled",
			"invalid",
		]);
		expect(connections).toBe(0);
		const demo = await run(["--demo", "--print", "--prompt", "hello"]);
		expect(demo.code, demo.stderr).toBe(0);
		expect(demo.stdout).toContain("离线演示已运行");
	} finally {
		server.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30000);
