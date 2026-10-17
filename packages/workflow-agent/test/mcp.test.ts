import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fixture } from "./helpers";
import { Policy } from "../src/policy/policy";
import { Sandbox } from "../src/processes/sandbox";
import { ManagedMcp } from "../src/mcp/manager";

export function remoteMcp(deleteDelay = 0) {
	const requests: { method: string; params?: { name?: string; arguments?: unknown }; authorization: string | null }[] =
		[];
	let updates = 0;
	let closed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				closed++;
				if (deleteDelay) await Bun.sleep(deleteDelay);
				return new Response(null, { status: 200 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as {
				method: string;
				params?: { name?: string; arguments?: unknown };
				id?: string;
			};
			requests.push({ ...body, authorization: request.headers.get("authorization") });
			if (body.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (body.method === "initialize")
				result = {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "fixture", version: "1" },
					capabilities: { tools: {} },
					instructions: "UNTRUSTED_MCP_INSTRUCTIONS_NEVER_SYSTEM",
				};
			if (body.method === "tools/list")
				result = {
					tools: [
						{
							name: "update_record",
							description: "update fixture",
							inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
							annotations: { readOnlyHint: true },
						},
					],
				};
			if (body.method === "tools/call") {
				updates++;
				if ((body.params?.arguments as { value?: string })?.value === "cancel") await Bun.sleep(350);
				result = { content: [{ type: "text", text: "MCP_LOCAL_OK" }], structuredContent: body.params?.arguments };
				if (request.headers.has("x-echo")) {
					const echoed = request.headers.get("x-echo")!;
					result = {
						content: [{ type: "text", text: echoed }],
						structuredContent: { ok: true, echo: echoed, nested: [echoed], [echoed]: "key" },
					};
				}
			}
			return Response.json(
				{ jsonrpc: "2.0", id: body.id, result },
				{ headers: { "Mcp-Session-Id": "local-fixture-session" } },
			);
		},
	});
	return {
		requests,
		get updates() {
			return updates;
		},
		get closed() {
			return closed;
		},
		url: `http://127.0.0.1:${server.port}/mcp`,
		close() {
			server.stop(true);
		},
	};
}

test("MCP permission revision changes during preparation prevent a local process from starting", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-permission-prepare-"));
	const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: true });
	policy.setApprovalMode("full");
	const sandbox = new Sandbox(root, root, []);
	sandbox.fullAccess = true;
	const preparing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const wrapped = spyOn(sandbox, "wrap").mockImplementation(async command => {
		preparing.resolve();
		await release.promise;
		return command;
	});
	const marker = path.join(root, "not-started.txt");
	const mcp = new ManagedMcp(
		{ fixture: { command: "/usr/bin/touch", args: [marker] } },
		policy,
		sandbox,
		root,
		root,
		false,
	);
	const pending = mcp.list("fixture").then(
		() => undefined,
		error => String(error),
	);
	try {
		await preparing.promise;
		policy.setApprovalMode("manual");
		sandbox.fullAccess = false;
		release.resolve();
		const outcome = await pending;
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(outcome).toMatch(/授权状态.*变更/);
	} finally {
		release.resolve();
		await pending;
		await mcp.close();
		wrapped.mockRestore();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("MCP permission revision changes after call approval prevent external execution", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-permission-call-"));
	const remote = remoteMcp();
	const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: true });
	policy.setApprovalMode("full");
	const sandbox = new Sandbox(root, root, []);
	const mcp = new ManagedMcp({ fixture: { url: remote.url } }, policy, sandbox, root, root, false);
	const approved = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const authorize = policy.authorize.bind(policy);
	const approval = spyOn(policy, "authorize").mockImplementation(async (request, signal) => {
		await authorize(request, signal);
		if (request.tool.startsWith("mcp-call:")) {
			approved.resolve();
			await release.promise;
		}
	});
	try {
		await mcp.list("fixture");
		const pending = mcp.call("fixture", "update_record", { value: "not-sent" }).then(
			() => undefined,
			error => String(error),
		);
		await approved.promise;
		policy.setApprovalMode("manual");
		release.resolve();
		const outcome = await pending;
		expect(remote.updates).toBe(0);
		expect(outcome).toMatch(/授权状态.*变更/);
	} finally {
		release.resolve();
		await mcp.close();
		approval.mockRestore();
		remote.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("configured MCP servers stay cold, invalid optional entries do not block chat, and light mode has no MCP tools", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.mcpServers = {
			fixture: { type: "http", url: remote.url },
			unsupported: { type: "sse", url: remote.url },
			disabled: { enabled: false, command: "/bin/false" },
		};
		f.callTool("mcp_list", {});
		const run = await f.run({ approve: true });
		expect(run.code, run.stderr).toBe(0);
		expect(remote.requests).toHaveLength(0);
		expect(run.result.mcp.find((x: { name: string }) => x.name === "unsupported").status).toBe("invalid");
		const light = await f.run({ light: true });
		expect(light.code, light.stderr).toBe(0);
		expect(light.result.tools).toEqual([]);
		expect(remote.requests).toHaveLength(0);
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("MCP connection approval never authorizes a tool call, even with a read-only hint", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { fixture: { url: remote.url } };
		f.callTool("mcp_call", { server: "fixture", tool: "update_record", arguments: { value: "secret-document" } });
		const run = await f.run({ approve: "connect" });
		expect(run.code, run.stderr).toBe(0);
		expect(remote.requests.some(request => request.method === "tools/list")).toBe(true);
		expect(remote.updates).toBe(0);
		expect(JSON.stringify(run.result.messages)).toContain("被拒绝");
		expect(remote.closed).toBe(1);
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("approved MCP calls carry only selected credentials and preserve structured results without injecting instructions", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.permissions.allowNetwork = true;
		// eslint-disable-next-line no-template-curly-in-string
		f.config.mcpServers = { fixture: { url: remote.url, headers: { Authorization: "Bearer ${PRODUCT_TEST_KEY}" } } };
		f.callTool("mcp_call", { server: "fixture", tool: "update_record", arguments: { value: "approved" } });
		const run = await f.run({ approve: true });
		expect(run.code, run.stderr).toBe(0);
		expect(remote.updates).toBe(1);
		expect(remote.requests.find(request => request.method === "tools/call")?.authorization).toBe(
			"Bearer fake-local-key",
		);
		expect(JSON.stringify(run.result.messages)).toContain("MCP_LOCAL_OK");
		expect(JSON.stringify(run.result.messages)).toContain("approved");
		expect(JSON.stringify(f.requests)).not.toContain("UNTRUSTED_MCP_INSTRUCTIONS_NEVER_SYSTEM");
		expect(JSON.stringify(run.result)).not.toContain("fake-local-key");
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("plan mode and disabled networking block MCP before any connection", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.mcpServers = { fixture: { url: remote.url } };
		f.callTool("mcp_call", { server: "fixture", tool: "update_record", arguments: { value: "blocked" } });
		const offline = await f.run({ approve: true });
		expect(offline.code, offline.stderr).toBe(0);
		expect(JSON.stringify(offline.result.messages)).toContain("联网");
		f.config.permissions.allowNetwork = true;
		const plan = await f.run({ approve: true, plan: true });
		expect(plan.code, plan.stderr).toBe(0);
		expect(JSON.stringify(plan.result.messages)).toContain("计划模式");
		expect(remote.requests).toHaveLength(0);
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("MCP disconnect/reconnect works and cancelling an accepted call never replays it", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { fixture: { url: remote.url } };
		const run = await f.run({ approve: true, action: "mcp-lifecycle" });
		expect(run.code, run.stderr).toBe(0);
		expect(remote.requests.filter(request => request.method === "initialize")).toHaveLength(2);
		expect(remote.updates).toBe(1);
		expect(run.result.actionResult).toContain("未知");
		expect(run.result.mcp[0].status).toBe("error");
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("invalid optional MCP credentials stay disabled without preventing ordinary conversation", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.mcpServers = { fixture: { url: remote.url, headers: { Authorization: "inline-fixture-secret" } } };
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.mcp[0].status).toBe("invalid");
		expect(JSON.stringify(run.result)).not.toContain("inline-fixture-secret");
		expect(remote.requests).toHaveLength(0);
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

for (const [label, secret] of [
	["escaped JSON characters", 'fixture-quote"slash\\tail'],
	["JSON boolean spelling", "true"],
]) {
	test(`MCP redaction handles ${label} without exposing credentials or corrupting structured results`, async () => {
		const f = await fixture();
		const remote = remoteMcp();
		try {
			f.config.permissions.allowNetwork = true;
			// eslint-disable-next-line no-template-curly-in-string
			f.config.mcpServers = { fixture: { url: remote.url, headers: { "X-Echo": "${PRODUCT_TEST_KEY}" } } };
			f.callTool("mcp_call", { server: "fixture", tool: "update_record", arguments: { value: "echo" } });
			const run = await f.run({ approve: true, testKey: secret });
			expect(run.code, run.stderr).toBe(0);
			const message = run.result.messages.find((message: { role: string }) => message.role === "toolResult");
			expect(message.isError, JSON.stringify(message)).not.toBe(true);
			const output = JSON.parse(message.content[0].text);
			expect(output.content[0].text).toBe("[REDACTED]");
			expect(output.structuredContent).toEqual({
				ok: true,
				echo: "[REDACTED]",
				nested: ["[REDACTED]"],
				"[REDACTED]": "key",
			});
		} finally {
			remote.close();
			await f.close();
		}
	}, 30000);
}

test("switching to plan mode while MCP approval is open prevents the newly forbidden operation", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { fixture: { url: remote.url } };
		f.callTool("mcp_call", { server: "fixture", tool: "update_record", arguments: { value: "never-send" } });
		const connecting = await f.run({ approve: true, planOnApproval: "connect" });
		expect(connecting.code, connecting.stderr).toBe(0);
		expect(remote.requests).toHaveLength(0);
		const calling = await f.run({ approve: true, planOnApproval: "call" });
		expect(calling.code, calling.stderr).toBe(0);
		expect(remote.updates).toBe(0);
		expect(JSON.stringify(calling.result.messages)).toContain("计划模式");
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("closing the product cancels a pending MCP approval without waiting for a user's answer", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { fixture: { url: remote.url } };
		const run = await f.run({ approve: true, action: "mcp-close-pending" });
		expect(run.code, run.stderr).toBe(0);
		expect(remote.updates).toBe(0);
		expect(remote.closed).toBe(1);
		expect(run.result.mcp[0].status).toBe("disconnected");
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("immediate MCP close never starts a later approval or leaves an unhandled rejection", async () => {
	const f = await fixture();
	const remote = remoteMcp();
	try {
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { fixture: { url: remote.url } };
		const run = await f.run({ action: "mcp-close-immediately" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult.approvals).toBe(0);
		expect(remote.requests).toHaveLength(0);
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);

test("product exit remains bounded when a legacy OMP environment setting disables timeouts", async () => {
	const f = await fixture();
	const remote = remoteMcp(2000);
	try {
		f.config.permissions.allowNetwork = true;
		f.config.mcpServers = { fixture: { url: remote.url, timeout: 500 } };
		const run = await f.run({ approve: true, action: "mcp-timed-close", testMcpTimeout: "0" });
		expect(run.code, run.stderr).toBe(0);
		expect(remote.closed).toBe(1);
		expect(run.result.actionResult.elapsed).toBeLessThan(1500);
	} finally {
		remote.close();
		await f.close();
	}
}, 30000);
