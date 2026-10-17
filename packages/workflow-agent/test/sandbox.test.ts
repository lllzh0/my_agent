import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fixture } from "./helpers";

const sandboxTest = process.env.MY_AGENT_SANDBOX_TEST === "1" && process.platform === "darwin" ? test : test.skip;

sandboxTest(
	"the CLI auto mode passes the human task to a separate reviewer before sandbox execution",
	async () => {
		const f = await fixture();
		try {
			f.reviewReply("allow");
			f.callTool("bash", { command: "printf AUTO_REVIEWED_COMMAND" });
			const run = await f.cli(
				["--permissions", "auto"],
				"Print AUTO_REVIEWED_COMMAND to verify the command channel",
			);
			expect(run.code, run.stderr).toBe(0);
			const toolMessages = f.requests.at(-1)!.messages.filter(message => message.role === "tool");
			expect(JSON.stringify(toolMessages)).toContain("AUTO_REVIEWED_COMMAND");
			expect(JSON.stringify(toolMessages)).toContain("succeeded");
			const reviewIndex = f.requestHeaders.findIndex(header => header.sessionId?.endsWith(":review"));
			expect(reviewIndex).toBeGreaterThanOrEqual(0);
			expect(f.requests[reviewIndex].tools ?? []).toHaveLength(0);
			expect(JSON.stringify(f.requests[reviewIndex].messages)).toContain("Print AUTO_REVIEWED_COMMAND");
		} finally {
			await f.close();
		}
	},
	30000,
);

sandboxTest(
	"a sandboxed Git command can write metadata only with the explicit Git scope",
	async () => {
		const f = await fixture();
		try {
			// Repository creation writes protected hooks/config; ordinary Git scope
			// permits staging, while those security files remain protected.
			f.callTool("bash", { command: "git init --quiet" });
			const initialized = await f.run({
				action: "commands",
				commands: ["/permissions full"],
				promptAfterCommands: "Initialize this temporary repository",
			});
			expect(initialized.code, initialized.stderr).toBe(0);
			expect(initialized.result.jobs[0].status).toBe("succeeded");
			await Bun.write(path.join(f.cwd, "stage.txt"), "STAGED_FILE");
			f.callTool("bash", { command: "git add stage.txt" });
			const denied = await f.run({ approve: true });
			expect(denied.code, denied.stderr).toBe(0);
			expect(denied.result.jobs[0].status).toBe("failed");
			expect(await Bun.file(path.join(f.cwd, ".git/index")).exists()).toBe(false);
			f.callTool("bash", { command: "git add stage.txt", gitWrite: true });
			const allowed = await f.run({ approve: true });
			expect(allowed.code, allowed.stderr).toBe(0);
			expect(allowed.result.jobs[0].status, JSON.stringify(allowed.result.messages)).toBe("succeeded");
			expect(await Bun.file(path.join(f.cwd, ".git/index")).exists()).toBe(true);
		} finally {
			await f.close();
		}
	},
	30000,
);

sandboxTest(
	"sandboxed builds can use selected toolchain read roots and external output roots",
	async () => {
		const f = await fixture();
		try {
			const toolchain = path.join(f.root, "toolchain");
			const output = path.join(f.root, "build-output");
			await Bun.write(path.join(toolchain, "input.txt"), "TOOLCHAIN_INPUT");
			await fs.mkdir(output);
			f.config.permissions.readRoots = [toolchain];
			f.config.permissions.writeRoots = [output];
			f.callTool("bash", {
				command: "cat " + quote(path.join(toolchain, "input.txt")) + " > " + quote(path.join(output, "result.txt")),
			});
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.jobs[0].status).toBe("succeeded");
			expect(await Bun.file(path.join(output, "result.txt")).text()).toBe("TOOLCHAIN_INPUT");
		} finally {
			await f.close();
		}
	},
	30000,
);

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

sandboxTest(
	"real model bash calls use the macOS sandbox, including a state directory inside the workspace",
	async () => {
		const f = await fixture(true);
		let connections = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				connections++;
				return new Response("sandbox-network-probe");
			},
		});
		try {
			const url = `http://127.0.0.1:${server.port}/`;
			expect(await (await fetch(url)).text()).toBe("sandbox-network-probe");
			await Bun.write(path.join(f.home, "protected.txt"), "PRIVATE_SANDBOX_FIXTURE");
			await Bun.write(path.join(f.cwd, ".omp/config.yml"), "ORIGINAL_CONFIG");
			await Bun.write(path.join(f.cwd, ".env"), "WORKSPACE_CREDENTIAL_FIXTURE");
			const outside = path.join(f.root, "outside.txt");
			f.callTool("bash", {
				command: [
					"printf 'sandbox-ready\\n'",
					'printf scratch-ok > "$TMPDIR/check.txt" && cat "$TMPDIR/check.txt"',
					`cat ${quote(path.join(f.home, "protected.txt"))}; printf 'state-read:%s\\n' "$?"`,
					`cat ${quote(path.join(f.cwd, ".env"))}; printf 'credential-read:%s\\n' "$?"`,
					`printf unsafe > ${quote(path.join(f.cwd, ".env"))}; printf 'credential-write:%s\\n' "$?"`,
					`printf unsafe > ${quote(path.join(f.home, "protected.txt"))}; printf 'state-write:%s\\n' "$?"`,
					`printf unsafe > ${quote(outside)}; printf 'outside-write:%s\\n' "$?"`,
					`printf unsafe > ${quote(path.join(f.cwd, ".omp/config.yml"))}; printf 'config-write:%s\\n' "$?"`,
					`/usr/bin/curl --noproxy '*' --fail --max-time 2 ${quote(url)}; printf 'network:%s\\n' "$?"`,
					// This interpolation is intentionally evaluated by the sandboxed shell.
					// eslint-disable-next-line no-template-curly-in-string
					'test -z "${PRODUCT_TEST_KEY-}"; printf \'credential-absent:%s\\n\' "$?"',
				].join("\n"),
			});
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.jobs).toHaveLength(1);
			const result = run.result.messages.find((message: { role: string }) => message.role === "toolResult");
			const messages = JSON.parse(result.content[0].text).log as string;
			expect(messages).toContain("sandbox-ready");
			expect(messages).toContain("scratch-ok");
			expect(messages).not.toContain("PRIVATE_SANDBOX_FIXTURE");
			expect(messages).not.toContain("WORKSPACE_CREDENTIAL_FIXTURE");
			for (const label of [
				"state-read",
				"state-write",
				"credential-read",
				"credential-write",
				"outside-write",
				"config-write",
				"network",
			])
				expect(messages).toMatch(new RegExp(`${label}:[1-9]`));
			expect(messages).toContain("credential-absent:0");
			expect(await Bun.file(path.join(f.home, "protected.txt")).text()).toBe("PRIVATE_SANDBOX_FIXTURE");
			expect(await Bun.file(path.join(f.cwd, ".omp/config.yml")).text()).toBe("ORIGINAL_CONFIG");
			expect(await Bun.file(path.join(f.cwd, ".env")).text()).toBe("WORKSPACE_CREDENTIAL_FIXTURE");
			expect(await Bun.file(outside).exists()).toBe(false);
			expect(connections).toBe(1);
		} finally {
			server.stop(true);
			await f.close();
		}
	},
	30000,
);

sandboxTest(
	"local MCP uses the product sandbox and closing the host kills its descendants",
	async () => {
		const f = await fixture(true);
		let connections = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				connections++;
				return new Response("probe");
			},
		});
		try {
			const file = path.join(f.cwd, "mcp-server.ts");
			await Bun.write(file, Bun.file(path.join(import.meta.dir, "mcp-stdio-fixture.ts")));
			const protectedFile = path.join(f.home, "private.txt");
			const outside = path.join(f.root, "escaped.txt");
			await Bun.write(protectedFile, "private-fixture");
			await Bun.write(path.join(f.cwd, ".env"), "credential-fixture");
			f.config.mcpServers = {
				fixture: {
					command: process.execPath,
					args: ["--no-env-file", file, protectedFile, outside, `http://127.0.0.1:${server.port}/`],
					// eslint-disable-next-line no-template-curly-in-string
					env: { SELECTED: "${PRODUCT_TEST_KEY}" },
				},
			};
			f.callTool("mcp_call", { server: "fixture", tool: "probe", arguments: {} });
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			const message = run.result.messages.find((message: { role: string }) => message.role === "toolResult");
			expect(message.isError, JSON.stringify(message)).not.toBe(true);
			const probe = JSON.parse(message.content[0].text).structuredContent;
			expect(probe, JSON.stringify(message)).toBeDefined();
			expect(probe.inherited).toBe(false);
			expect(probe.selected).toBe(true);
			expect(probe.protectedRead).toBe(false);
			expect(probe.credentialRead).toBe(false);
			expect(probe.outsideWrite).toBe(false);
			expect(probe.workspaceWrite).toBe(true);
			expect(probe.network).toBe(false);
			expect(connections).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "mcp-result.txt")).text()).toBe("stdio-workspace-ok");
			expect(() => process.kill(probe.pid, 0)).toThrow();
			expect(() => process.kill(probe.child, 0)).toThrow();
		} finally {
			server.stop(true);
			await f.close();
		}
	},
	30000,
);

sandboxTest(
	"closing an OMP product session stops its managed background shell",
	async () => {
		const f = await fixture();
		try {
			f.callTool("bash", { command: "printf background-ready; sleep 60", background: true });
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.jobs).toHaveLength(1);
			const pid = run.result.jobs[0].pid as number;
			expect(() => process.kill(pid, 0)).toThrow();
			const resumed = await f.run({ resume: run.result.sessionFile, action: "input", command: "/agent" });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.jobs[0].status).toBe("cancelled");
		} finally {
			await f.close();
		}
	},
	30000,
);
