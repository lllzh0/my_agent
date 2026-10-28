import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "../src/processes/sandbox";
import { Supervisor } from "../src/processes/supervisor";
import { Policy } from "../src/policy/policy";
import { quoteCommand } from "../src/processes/shell";
import { windowsSandboxDependencies } from "../src/processes/sandbox-status";
import { ManagedMcp } from "../src/mcp/manager";
import { Process } from "@oh-my-pi/pi-natives";

const missingSandbox = process.platform === "win32" && (await windowsSandboxDependencies()).errors.length > 0;

test.skipIf(!missingSandbox)(
	"an unprovisioned Windows sandbox refuses execution without a host-shell fallback",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-no-fallback-"));
		const home = path.join(root, "home");
		await fs.mkdir(home);
		const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false });
		policy.setApprover(async () => "once");
		const jobs = new Supervisor(home, root, policy, new Sandbox(root, home, []));
		try {
			await expect(jobs.start("Set-Content -LiteralPath escaped.txt -Value forbidden")).rejects.toThrow(
				/沙箱未就绪/,
			);
			expect(await Bun.file(path.join(root, "escaped.txt")).exists()).toBe(false);
			expect(jobs.list()).toEqual([]);
		} finally {
			await jobs.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

test.skipIf(process.platform !== "win32" || process.env.MY_AGENT_WINDOWS_SANDBOX_TEST !== "1")(
	"real Windows isolation allows workspace writes and blocks protected files, outside writes and network",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-isolation-"));
		const cwd = path.join(root, "workspace");
		const home = path.join(cwd, "product-home");
		const profileFixture = await fs.mkdtemp(path.join(os.homedir(), "agent-isolation-fixture-"));
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(path.join(cwd, ".git"));
		await Bun.write(path.join(cwd, ".env"), "ISOLATION_SENTINEL");
		await Bun.write(path.join(cwd, "env.local"), "ISOLATION_SENTINEL");
		await Bun.write(path.join(profileFixture, "private.txt"), "PRIVATE_STATE");
		await Bun.write(path.join(home, "private.txt"), "PRIVATE_STATE");
		await Bun.write(path.join(cwd, ".git", "config"), "metadata");
		const policy = new Policy(cwd, { readRoots: [], writeRoots: [], allowNetwork: false });
		policy.setApprover(async () => "once");
		const sandbox = new Sandbox(cwd, home, [], [], home);
		const jobs = new Supervisor(home, cwd, policy, sandbox);
		const run = async (command: string) => jobs.wait((await jobs.start(command, { timeoutMs: 15_000 })).id);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("HOST_NETWORK_OK") });
		try {
			expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("HOST_NETWORK_OK");
			const allowed = await run(
				"Set-Content -LiteralPath allowed.txt -Value '隔离写入'; Get-Content -LiteralPath allowed.txt",
			);
			expect(allowed.status, allowed.log).toBe("succeeded");
			expect(allowed.log).toContain("隔离写入");
			for (const file of [
				path.join(cwd, ".env"),
				path.join(cwd, "env.local"),
				path.join(home, "private.txt"),
				path.join(profileFixture, "private.txt"),
			]) {
				const denied = await run(`Get-Content -LiteralPath '${file.replaceAll("'", "''")}'`);
				expect(denied.status, denied.log).toBe("failed");
				expect(denied.log).not.toContain("ISOLATION_SENTINEL");
				expect(denied.log).not.toContain("PRIVATE_STATE");
			}
			for (const file of [path.join(root, "outside.txt"), path.join(cwd, ".git", "config")])
				expect(
					(await run(`Set-Content -LiteralPath '${file.replaceAll("'", "''")}' -Value forbidden`)).status,
				).toBe("failed");
			expect(await Bun.file(path.join(root, "outside.txt")).exists()).toBe(false);
			expect(await Bun.file(path.join(cwd, ".git", "config")).text()).toBe("metadata");
			// Show the same executable runs; refusal cannot be mistaken for a
			// missing runtime, DNS failure or an unreachable external website.
			expect(server.port! < 60080 || server.port! > 60089).toBe(true);
			const network = await run(
				quoteCommand([
					process.execPath,
					"--no-env-file",
					"-e",
					`import {connect} from 'node:net'; console.log('RUNTIME_READY'); const socket=connect({host:'127.0.0.1',port:${server.port}},()=>{socket.destroy();process.exit(2)}); socket.on('error',error=>{console.log(error.code);process.exit(3)}); setTimeout(()=>{socket.destroy();process.exit(4)},4000)`,
				]),
			);
			expect(network.status, network.log).toBe("failed");
			expect(network.log).toContain("RUNTIME_READY");
			expect(network.exitCode).toBe(3);
			const proxy = await run(
				quoteCommand([
					process.execPath,
					"--no-env-file",
					"-e",
					"console.log('PROXY_READY'); fetch('http://example.com',{proxy:process.env.HTTP_PROXY,signal:AbortSignal.timeout(4000)}).then(r=>{console.log(r.status);process.exit(r.status===403?0:2)}).catch(()=>process.exit(3))",
				]),
			);
			expect(proxy.status, proxy.log).toBe("succeeded");
			expect(proxy.log).toContain("PROXY_READY");
			expect(proxy.log).toContain("403");
		} finally {
			server.stop(true);
			await jobs.close();
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(profileFixture, { recursive: true, force: true });
		}
	},
	600_000,
);

test.skipIf(process.platform !== "win32")(
	"Windows local MCP refuses unsupported isolated stdin before any process starts",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-mcp-blocked-"));
		const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false });
		let approvals = 0;
		policy.setApprover(async () => {
			approvals++;
			return "once";
		});
		const sandbox = new Sandbox(root, root, []);
		const marker = path.join(root, "unexpected.txt");
		const mcp = new ManagedMcp(
			{
				fixture: {
					command: process.execPath,
					args: ["-e", `await Bun.write(${JSON.stringify(marker)},'unexpected')`],
				},
			},
			policy,
			sandbox,
			root,
			root,
			false,
		);
		try {
			await expect(mcp.list("fixture")).rejects.toThrow(/标准输入转发尚不可用/);
			expect(await Bun.file(marker).exists()).toBe(false);
			expect(approvals).toBe(0);
		} finally {
			await mcp.close();
			await sandbox.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

test.skipIf(process.platform !== "win32")(
	"explicit full-access Windows MCP owns stdin and closes its descendants",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-windows-mcp-"));
		const cwd = path.join(root, "workspace");
		const home = path.join(cwd, "product-home");
		await fs.mkdir(home, { recursive: true });
		await Bun.write(path.join(home, "private.txt"), "PRIVATE_STATE");
		await Bun.write(path.join(cwd, ".env"), "SYNTHETIC_CREDENTIAL");
		// A self-contained server must not discover package configuration in
		// the private test runner's parent directory.
		await Bun.write(path.join(cwd, "package.json"), '{"type":"module"}');
		const fixture = path.join(cwd, "mcp-server.ts");
		await Bun.write(fixture, Bun.file(path.join(import.meta.dir, "mcp-stdio-fixture.ts")));
		const outside = path.join(root, "outside.txt");
		const policy = new Policy(cwd, { readRoots: [], writeRoots: [], allowNetwork: false });
		policy.setApprover(async () => "once");
		policy.setApprovalMode("full");
		const sandbox = new Sandbox(cwd, home, []);
		sandbox.fullAccess = true;
		const previousKey = process.env.PRODUCT_TEST_KEY;
		process.env.PRODUCT_TEST_KEY = "fake-local-key";
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("FULL_NETWORK_OK") });
		const mcp = new ManagedMcp(
			{
				fixture: {
					command: process.execPath,
					args: [
						"--no-env-file",
						fixture,
						path.join(home, "private.txt"),
						outside,
						`http://127.0.0.1:${server.port}`,
					],
					timeout: 30_000,
				},
			},
			policy,
			sandbox,
			cwd,
			home,
			false,
		);
		try {
			await mcp.list("fixture");
			const response = (await mcp.call("fixture", "probe", {})) as {
				structuredContent: Record<string, unknown>;
			};
			expect(response.structuredContent).toMatchObject({
				inherited: true,
				protectedRead: true,
				credentialRead: true,
				outsideWrite: true,
				workspaceWrite: true,
				network: true,
			});
			expect(await Bun.file(path.join(cwd, "mcp-result.txt")).text()).toBe("stdio-workspace-ok");
			expect(await Bun.file(outside).text()).toBe("escape");
			const child = Process.fromPid(Number(response.structuredContent.child));
			expect(child).not.toBeNull();
			await mcp.close();
			expect(await child!.waitForExit({ timeoutMs: 3000 })).toBe(true);
		} finally {
			await mcp.close();
			await sandbox.close();
			server.stop(true);
			if (previousKey === undefined) delete process.env.PRODUCT_TEST_KEY;
			else process.env.PRODUCT_TEST_KEY = previousKey;
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	120_000,
);
