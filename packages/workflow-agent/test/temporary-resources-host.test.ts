import { expect, test } from "bun:test";
import * as path from "node:path";
import { builtinPreset } from "../src/presets/presets";
import { fixture, HOST_TEST_TIMEOUT } from "./helpers";

async function skillFixture() {
	const f = await fixture();
	const skill = path.join(f.home, "skills/brainstorming/SKILL.md");
	await Bun.write(
		skill,
		"---\nname: brainstorming\ndescription: Plan a bounded task\n---\nRESOURCE_SKILL_BODY_MARKER\n",
	);
	f.config.resources.skills = [skill];
	const presetFile = path.join(f.home, "presets/limited/preset.json");
	const preset = JSON.stringify({ ...builtinPreset("bare"), id: "limited", name: "limited", tools: ["read"] });
	await Bun.write(presetFile, preset);
	return { ...f, presetFile, preset };
}

test(
	"model can load a preset-excluded registered skill once, without persisting its activation",
	async () => {
		const f = await skillFixture();
		try {
			f.callTools(
				[0, 1].map(index => ({
					name: "request_skill",
					arguments: { name: "brainstorming", args: `task ${index}`, reason: "Plan this task" },
				})),
			);
			const run = await f.run({ preset: "limited", approveResource: "once" });
			expect(run.code, run.stderr).toBe(0);
			expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("RESOURCE_SKILL_BODY_MARKER");
			expect(
				run.result.resourceApprovals.filter((request: { kind: string }) => request.kind === "skill"),
			).toHaveLength(2);
			expect(
				run.result.temporaryResources.skills.find((entry: { name: string }) => entry.name === "brainstorming")
					.temporary,
			).toBe(false);
			expect(await Bun.file(f.presetFile).text()).toBe(f.preset);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"skill run grant survives a new conversation and disappears on cold recovery",
	async () => {
		const f = await skillFixture();
		try {
			f.respond(request =>
				request.messages.some(message => message.role === "tool")
					? { text: "DONE" }
					: {
							call: {
								name: "request_skill",
								arguments: { name: "brainstorming", args: "scope", reason: "Plan task" },
							},
						},
			);
			const run = await f.run({
				preset: "limited",
				approveResource: "run",
				promptsBefore: ["first"],
				action: "commands",
				commands: ["/new"],
				promptAfterCommands: "second",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(
				run.result.resourceApprovals.filter((request: { kind: string }) => request.kind === "skill"),
			).toHaveLength(1);
			expect(
				run.result.temporaryResources.skills.find((entry: { name: string }) => entry.name === "brainstorming")
					.temporary,
			).toBe(true);
			const cold = await f.run({
				preset: "limited",
				resume: run.result.sessionFile,
				action: "commands",
				commands: ["/skills list"],
			});
			expect(cold.code, cold.stderr).toBe(0);
			expect(
				cold.result.temporaryResources.skills.find((entry: { name: string }) => entry.name === "brainstorming")
					.temporary,
			).toBe(false);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT * 2,
);

function remote() {
	const calls: string[] = [];
	let closed = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				closed++;
				return new Response(null, { status: 200 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as { id?: string; method: string; params?: { name: string } };
			if (body.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (body.method === "initialize")
				result = {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "resource-fixture", version: "1" },
					capabilities: { tools: {} },
				};
			if (body.method === "tools/list")
				result = {
					tools: ["lookup", "erase"].map(name => ({
						name,
						inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
					})),
				};
			if (body.method === "tools/call") {
				calls.push(body.params!.name);
				result = { content: [{ type: "text", text: "MCP_RESOURCE_RESULT" }] };
			}
			return Response.json(
				{ jsonrpc: "2.0", id: body.id, result },
				{ headers: { "Mcp-Session-Id": "resource-session" } },
			);
		},
	});
	return {
		calls,
		url: `http://127.0.0.1:${server.port}/mcp`,
		get closed() {
			return closed;
		},
		close() {
			server.stop(true);
		},
	};
}

test(
	"preset-excluded MCP run grants allow one tool and block a second tool at actual execution",
	async () => {
		const f = await skillFixture();
		const server = remote();
		try {
			f.config.permissions.allowNetwork = true;
			f.config.mcpServers = { library: { url: server.url } };
			f.callTools([
				{
					name: "request_mcp",
					arguments: {
						server: "library",
						tool: "lookup",
						arguments: { query: "first" },
						reason: "Search local fixture",
					},
				},
				{ name: "mcp_call", arguments: { server: "library", tool: "erase", arguments: { query: "denied" } } },
			]);
			const run = await f.run({
				preset: "limited",
				approve: true,
				approveResource: "run",
				denyResourceKey: JSON.stringify(["library", "tool", "erase"]),
			});
			expect(run.code, run.stderr).toBe(0);
			expect(server.calls).toEqual(["lookup"]);
			expect(
				run.result.resourceApprovals.some(
					(request: { key: string }) => request.key === JSON.stringify(["library", "tool", "erase"]),
				),
			).toBe(true);
			expect(await Bun.file(f.presetFile).text()).toBe(f.preset);
		} finally {
			await f.close();
			server.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"once MCP gateway calls keep tool permission separate and release their temporary connection",
	async () => {
		const f = await skillFixture();
		const server = remote();
		try {
			f.config.permissions.allowNetwork = true;
			f.config.mcpServers = { library: { url: server.url } };
			f.callTool("request_mcp", {
				server: "library",
				tool: "lookup",
				arguments: { query: "once" },
				reason: "One lookup",
			});
			const run = await f.run({ preset: "limited", approve: true, approveResource: "once" });
			expect(run.code, run.stderr).toBe(0);
			expect(server.calls).toEqual(["lookup"]);
			expect(server.closed).toBe(1);
			expect(f.requests.at(-1)?.tools?.some(tool => tool.function.name === "mcp_call")).toBe(false);
			expect(
				run.result.resourceApprovals.some(
					(request: { kind: string; key: string }) => request.kind === "tool" && request.key === "mcp_call",
				),
			).toBe(true);
		} finally {
			await f.close();
			server.close();
		}
	},
	HOST_TEST_TIMEOUT,
);
