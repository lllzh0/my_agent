import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { Supervisor } from "../src/processes/supervisor";
import { Policy, canonicalPath } from "../src/policy/policy";
import { quoteCommand } from "../src/processes/shell";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import { getBaseConfigRoot } from "@oh-my-pi/pi-utils/dirs";

// Tests the real Windows shell/lifecycle. This deliberately uses a harness backend,
// not the OS isolation backend; real isolation has a separate opt-in acceptance.
test.skipIf(process.platform !== "win32")(
	"PowerShell preserves Unicode, literal argv and native nonzero exits",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-shell-"));
		const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false });
		policy.setApprover(async () => "once");
		const jobs = new Supervisor(root, root, policy, { wrap: async command => command, close: async () => {} });
		try {
			const command = quoteCommand([
				process.execPath,
				"--no-env-file",
				"-e",
				"console.log(process.argv[1]); process.exit(7)",
				"中文 空格 ' $ &",
			]);
			const result = await jobs.wait((await jobs.start(command)).id);
			expect(result.status).toBe("failed");
			expect(result.exitCode).toBe(7);
			expect(result.log).toContain("中文 空格 ' $ &");
		} finally {
			await jobs.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);

test.skipIf(process.platform !== "win32")(
	"Windows cancellation and timeout terminate the managed process tree",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-tree-"));
		const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false });
		policy.setApprover(async () => "once");
		const jobs = new Supervisor(root, root, policy, { wrap: async command => command, close: async () => {} });
		try {
			const exe = process.execPath.replaceAll("'", "''");
			const job = await jobs.start(
				`$p=Start-Process -WindowStyle Hidden -FilePath '${exe}' -ArgumentList @('-e','"setInterval(()=>{},1000)"') -PassThru; Write-Output $p.Id; Start-Sleep -Seconds 30`,
			);
			for (let attempt = 0; attempt < 1500 && !/\d+/.test(jobs.output(job.id).text); attempt++) await Bun.sleep(10);
			const pid = Number(jobs.output(job.id).text.trim());
			expect(pid, jobs.output(job.id).text).toBeGreaterThan(0);
			const descendant = Process.fromPid(pid);
			expect(descendant).not.toBeNull();
			await jobs.stop(job.id);
			expect((await jobs.wait(job.id)).status).toBe("cancelled");
			expect(await descendant!.waitForExit({ timeoutMs: 2000 })).toBe(true);
			const timed = await jobs.wait((await jobs.start("Start-Sleep -Seconds 30", { timeoutMs: 100 })).id);
			expect(timed.status).toBe("timed_out");
		} finally {
			await jobs.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);

test.skipIf(process.platform !== "win32")(
	"Windows file policy rejects alternate streams, device aliases and ambiguous endings",
	async () => {
		for (const file of [
			"C:\\work\\file.txt:secret",
			"C:\\work\\CON.txt",
			"C:\\work\\.git ",
			"\\\\server\\share\\file",
			"\\\\.\\pipe\\name",
		])
			await expect(canonicalPath(file)).rejects.toThrow(/Windows 文件工具/);
		const previous = process.env.PI_CONFIG_DIR;
		const selected = path.resolve(process.cwd(), "separate-product-home", "omp");
		try {
			process.env.PI_CONFIG_DIR = selected;
			expect(getBaseConfigRoot()).toBe(selected);
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
		}
	},
);

test.skipIf(process.platform !== "win32")(
	"closing a real Windows MCP transport also stops its descendants",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-mcp-tree-"));
		const fixture = path.join(root, "server.ts");
		const pidFile = path.join(root, "child.json");
		await Bun.write(
			fixture,
			`const child=Bun.spawn([process.execPath,'--no-env-file','-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true}); await Bun.write(process.argv[2],JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);`,
		);
		const transport = new StdioTransport({
			type: "stdio",
			command: process.execPath,
			args: ["--no-env-file", fixture, pidFile],
			cwd: root,
		});
		let descendant: Process | null = null;
		try {
			await transport.connect();
			for (let attempt = 0; attempt < 1500 && !descendant; attempt++) {
				const record = (await Bun.file(pidFile)
					.json()
					.catch(() => undefined)) as { pid: number } | undefined;
				if (record) descendant = Process.fromPid(record.pid);
				if (!descendant) await Bun.sleep(10);
			}
			expect(descendant).not.toBeNull();
			await transport.close();
			expect(await descendant!.waitForExit({ timeoutMs: 2000 })).toBe(true);
			await transport.close();
		} finally {
			await transport.close();
			descendant?.killTree(9);
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
