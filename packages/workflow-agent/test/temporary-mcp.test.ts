import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { defaultConfig } from "../src/config/config";
import { ManagedMcp } from "../src/mcp/manager";
import { TemporaryMcp } from "../src/mcp/temporary";
import { Policy } from "../src/policy/policy";
import { Sandbox } from "../src/processes/sandbox";
import { TemporaryAccess, type AccessRequest } from "../src/runtime/temporary-access";
import type { RunState } from "../src/runtime/state";

function remote() {
	const calls: { name: string; arguments: unknown }[] = [];
	let connections = 0;
	let closed = 0;
	let tools: MCPToolDefinition[] = ["read_record", "update_record"].map(name => ({
		name,
		inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	}));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				closed++;
				return new Response(null, { status: 200 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as {
				method: string;
				id?: string;
				params?: { name: string; arguments: unknown };
			};
			if (body.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (body.method === "initialize") {
				connections++;
				result = {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "local", version: "1" },
					capabilities: { tools: {} },
				};
			}
			if (body.method === "tools/list") result = { tools };
			if (body.method === "tools/call") {
				calls.push(body.params!);
				const args = body.params?.arguments;
				if (args && typeof args === "object" && "value" in args && args.value === "slow") await Bun.sleep(200);
				result = { content: [{ type: "text", text: "LOCAL_OK" }] };
			}
			return Response.json(
				{ jsonrpc: "2.0", id: body.id, result },
				{ headers: { "Mcp-Session-Id": `session-${connections}` } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		calls,
		get connections() {
			return connections;
		},
		get closed() {
			return closed;
		},
		setTools(next: MCPToolDefinition[]) {
			tools = next;
		},
		stop() {
			server.stop(true);
		},
	};
}

test("unselected MCP candidates stay outside the active manager until explicitly requested", async () => {
	const f = await fixture();
	try {
		expect(f.manager.status()).toEqual([]);
		expect(f.temporary.list().map(entry => entry.name)).toEqual(["fixture"]);
		expect(f.server.connections).toBe(0);
		await f.temporary.discover("fixture", "inspect explicit candidate");
		expect(f.server.connections).toBe(1);
	} finally {
		await f.close();
	}
});

test("a tool schema changed while approval is pending never reaches business execution", async () => {
	const f = await fixture();
	try {
		f.access.setApprover(async request => {
			if (request.details.scope === "tool")
				f.server.setTools([
					{
						name: "read_record",
						inputSchema: {
							type: "object",
							properties: { value: { type: "string" }, changed: { type: "boolean" } },
							required: ["value"],
						},
					},
				]);
			return "run";
		});
		await expect(
			f.temporary.call("fixture", "read_record", { value: "pending" }, "approved snapshot"),
		).rejects.toThrow();
		expect(f.server.calls).toHaveLength(0);
	} finally {
		await f.close();
	}
});

async function fixture(baseline = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "temporary-mcp-"));
	const server = remote();
	const base = defaultConfig();
	base.mcpServers = {
		fixture: { url: server.url },
		invalid: { type: "sse", url: server.url },
		disabled: { enabled: false, command: "/bin/false" },
	};
	const config = structuredClone(base);
	config.mcpServers = baseline ? { fixture: base.mcpServers.fixture } : {};
	const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: true });
	policy.setApprovalMode("full");
	const sandbox = new Sandbox(root, root, []);
	const manager = new ManagedMcp(config.mcpServers, policy, sandbox, root, root, false);
	const state = { config, policy, light: false, mcp: manager } as RunState;
	const access = new TemporaryAccess(policy);
	const requests: AccessRequest[] = [];
	access.setApprover(async request => {
		requests.push(request);
		return "once";
	});
	const temporary = new TemporaryMcp(state, base, access);
	return {
		root,
		server,
		base,
		config,
		policy,
		sandbox,
		manager,
		state,
		access,
		requests,
		temporary,
		async close() {
			await temporary.close();
			access.close();
			await state.mcp.close();
			server.stop();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("manual run grants retain raw schemas with sensitive property names", async () => {
	const f = await fixture();
	try {
		f.server.setTools([
			{
				name: "read_record",
				inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
			},
		]);
		await f.temporary.grant("fixture", "read_record");
		f.access.setApprover(async request => (request.details.scope === "connection" ? "once" : "deny"));
		await f.manager.call("fixture", "read_record", { token: "PUBLIC_FIXTURE" });
		expect(f.server.calls).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("config changes during operation approval prevent the pending external call", async () => {
	const f = await fixture();
	try {
		f.policy.setApprovalMode("manual");
		f.policy.setApprover(async operation => {
			if (operation.tool.startsWith("mcp-call:")) f.base.mcpServers.fixture = { url: f.server.url, enabled: false };
			return "once";
		});
		await expect(f.temporary.call("fixture", "read_record", { value: "pending" }, "read")).rejects.toThrow();
		expect(f.server.calls).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("config changes during connection approval prevent even the pending connection", async () => {
	const f = await fixture();
	try {
		f.policy.setApprovalMode("manual");
		f.policy.setApprover(async () => {
			f.base.mcpServers.fixture = { url: f.server.url, timeout: 1001 };
			return "once";
		});
		await expect(f.temporary.discover("fixture", "inspect")).rejects.toThrow();
		expect(f.server.connections).toBe(0);
	} finally {
		await f.close();
	}
});

// Removing the manager scope hook would make direct manager calls reach the server here.
test("once is bound to one call, disconnects, and direct manager calls cannot bypass scope", async () => {
	const f = await fixture();
	try {
		expect(f.temporary.available("fixture")).toBe(true);
		expect(f.temporary.available("invalid")).toBe(false);
		expect(f.temporary.available("disabled")).toBe(false);
		expect(f.server.connections).toBe(0);
		await f.temporary.call("fixture", "read_record", { value: "one" }, "read approved record");
		expect(f.server.calls).toEqual([{ name: "read_record", arguments: { value: "one" } }]);
		expect(f.server.closed).toBe(1);
		f.access.setApprover(async () => "deny");
		await expect(f.manager.call("fixture", "update_record", { value: "forbidden" })).rejects.toThrow();
		expect(f.server.calls).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("discovery approves metadata only and invalid arguments never reach capability or business execution", async () => {
	const f = await fixture();
	try {
		await f.temporary.discover("fixture", "inspect tool directory");
		expect(f.requests).toHaveLength(1);
		expect(f.server.calls).toHaveLength(0);
		expect(f.server.closed).toBe(1);
		await expect(f.temporary.call("fixture", "read_record", {}, "invalid")).rejects.toThrow(/value/);
		expect(f.requests).toHaveLength(2); // only a fresh connection approval
		expect(f.server.calls).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("run permits only the selected tool, refreshes actual schemas, and revoke closes its connection", async () => {
	const f = await fixture();
	try {
		f.access.setApprover(async request => {
			f.requests.push(request);
			return "run";
		});
		await f.temporary.call("fixture", "read_record", { value: "first" }, "read record");
		const approved = f.requests.length;
		await f.manager.call("fixture", "read_record", { value: "second" });
		expect(f.requests).toHaveLength(approved);
		expect(f.server.connections).toBe(1);
		expect(f.server.closed).toBe(0);
		f.access.setApprover(async () => "deny");
		await expect(f.manager.call("fixture", "update_record", { value: "other" })).rejects.toThrow();
		expect(f.server.calls).toHaveLength(2);
		await f.temporary.discover("fixture", "reopen after denial").catch(() => undefined);
		await f.temporary.revoke("fixture", "read_record");
		expect(f.server.closed).toBeGreaterThan(0);
	} finally {
		await f.close();
	}
});

test("schema and config changes invalidate run grants before external execution", async () => {
	const f = await fixture();
	try {
		let allow = true;
		f.access.setApprover(async request => {
			f.requests.push(request);
			return allow ? "run" : "deny";
		});
		await f.temporary.call("fixture", "read_record", { value: "first" }, "read record");
		allow = false;
		f.server.setTools([
			{
				name: "read_record",
				inputSchema: {
					type: "object",
					properties: { value: { type: "string" }, version: { type: "string" } },
					required: ["value"],
				},
			},
		]);
		await expect(f.manager.call("fixture", "read_record", { value: "new schema" })).rejects.toThrow();
		expect(f.server.calls).toHaveLength(1);
		f.base.mcpServers.fixture = { url: f.server.url, timeout: 1000 };
		await expect(f.temporary.call("fixture", "read_record", { value: "new config" }, "changed")).rejects.toThrow();
		expect(f.server.calls).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("plan and disabled networking prevent temporary connections before approval", async () => {
	const f = await fixture();
	try {
		f.policy.mode = "plan";
		await expect(f.temporary.discover("fixture", "plan")).rejects.toThrow(/计划模式/);
		f.policy.mode = "execute";
		f.policy.setApprovalMode("manual");
		f.policy.settings.allowNetwork = false;
		await expect(f.temporary.discover("fixture", "offline")).rejects.toThrow(/联网/);
		await expect(f.temporary.discover("unknown", "unknown")).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
		expect(f.server.connections).toBe(0);
	} finally {
		await f.close();
	}
});

test("revoke cancels pending resource approval and close preserves baseline connection", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<"run">();
	try {
		f.access.setApprover(async () => {
			entered.resolve();
			return release.promise;
		});
		const pending = f.temporary
			.call("fixture", "read_record", { value: "pending" }, "wait")
			.catch(error => String(error));
		await entered.promise;
		await f.temporary.revoke("fixture");
		release.resolve("run");
		expect(await pending).toMatch(/变更|撤销|取消/);
		expect(f.server.calls).toHaveLength(0);
		expect(f.server.connections).toBe(0);
	} finally {
		release.resolve("run");
		await f.close();
	}
	const base = await fixture(true);
	try {
		await base.manager.list("fixture");
		await base.temporary.close();
		expect(base.server.closed).toBe(0);
		await base.manager.call("fixture", "read_record", { value: "baseline" });
		expect(base.server.calls).toHaveLength(1);
		expect(base.requests).toHaveLength(0);
	} finally {
		await base.close();
	}
});

test("rebind retains Host run scope but starts a cold session connection and cancellation never replays", async () => {
	const f = await fixture();
	try {
		f.access.setApprover(async request => {
			f.requests.push(request);
			return "run";
		});
		await f.temporary.call("fixture", "read_record", { value: "first" }, "read");
		await f.manager.close();
		f.state.mcp = new ManagedMcp({}, f.policy, f.sandbox, f.root, f.root, false);
		f.temporary.rebind();
		const count = f.requests.length;
		await f.temporary.call("fixture", "read_record", { value: "second" }, "read again");
		expect(f.requests).toHaveLength(count);
		expect(f.server.connections).toBe(2);
		await expect(
			f.temporary.call("fixture", "read_record", { value: "slow" }, "cancel", AbortSignal.timeout(30)),
		).rejects.toThrow();
		expect(f.server.calls).toHaveLength(3);
		expect(f.server.closed).toBe(2);
	} finally {
		await f.close();
	}
});
