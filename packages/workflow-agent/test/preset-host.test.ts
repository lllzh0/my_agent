import { expect, test } from "bun:test";
import * as path from "node:path";
import { builtinPreset, type PresetDefinition } from "../src/presets/presets";
import { fixture, HOST_TEST_TIMEOUT, type WireRequest } from "./helpers";

function remote(name: string) {
	const methods: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") return new Response(null, { status: 200 });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as { id?: string | number; method: string };
			methods.push(body.method);
			if (body.id === undefined) return new Response(null, { status: 202 });
			const result =
				body.method === "initialize"
					? { protocolVersion: "2025-11-25", serverInfo: { name, version: "1" }, capabilities: { tools: {} } }
					: body.method === "tools/list"
						? { tools: [{ name: "probe", inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text: `MCP_RESULT_ONLY_${name}` }] };
			return Response.json(
				{ jsonrpc: "2.0", id: body.id, result },
				{ headers: { "Mcp-Session-Id": `preset-${name}` } },
			);
		},
	});
	return { methods, url: `http://127.0.0.1:${server.port}/mcp`, close: () => server.stop(true) };
}

const names = (request: WireRequest) => (request.tools ?? []).map(tool => tool.function.name).sort();

test(
	"named cold recovery restores the saved connection key, effort and plan without inheriting another default",
	async () => {
		const f = await fixture();
		try {
			f.config.model.key = "primary";
			f.config.models = [{ ...f.config.model, key: "second", apiKeyEnv: "PRODUCT_TEST_KEY_B" }];
			await Bun.write(
				path.join(f.home, "presets/a/preset.json"),
				JSON.stringify({
					...builtinPreset("bare"),
					id: "a",
					name: "a",
					tools: ["read"],
					model: { default: "primary", allowed: ["primary", "second"] },
				}),
			);
			const first = await f.run({
				preset: "a",
				action: "commands",
				commands: ["/model second max", "/plan"],
				promptAfterCommands: "A_SECOND_CONNECTION",
			});
			expect(first.code, first.stderr).toBe(0);
			const manifest = await Bun.file(path.join(first.result.stateDir, "manifest.json")).json();
			expect(manifest.runtime.model.model).toBe("second");
			expect(manifest.runtime.model.effort).toBe("max");
			expect(manifest.runtime.plan).toBe(true);
			const savedManifest = await Bun.file(path.join(first.result.stateDir, "manifest.json")).text();
			const savedHistory = await Bun.file(first.result.sessionFile).text();
			const prepared = await f.run({ preset: "a", resume: first.result.sessionFile, prepared: true });
			expect(prepared.code).not.toBe(0);
			expect(prepared.stderr).toContain("预设尚未激活");
			expect(f.requests).toHaveLength(1);
			expect(await Bun.file(path.join(first.result.stateDir, "manifest.json")).text()).toBe(savedManifest);
			expect(await Bun.file(first.result.sessionFile).text()).toBe(savedHistory);
			const resumed = await f.run({
				preset: "a",
				resume: first.result.sessionFile,
				action: "submit",
				command: "A_SECOND_RESTORED",
			});
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.stateSessionId).toBe(first.result.stateSessionId);
			expect(f.requests).toHaveLength(2);
			expect(f.requestHeaders.every(header => header.authorization === "Bearer fake-second-key")).toBe(true);
			expect(JSON.stringify(f.requests.at(-1))).toContain("A_SECOND_CONNECTION");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"A to B to resumed A keeps actual requests, selected MCP, credentials, history and undo records separate",
	async () => {
		const f = await fixture();
		const a = remote("A");
		const b = remote("B");
		try {
			f.config.model.key = "primary";
			f.config.models = [{ ...f.config.model, key: "second", apiKeyEnv: "PRODUCT_TEST_KEY_B" }];
			f.config.permissions.allowNetwork = true;
			f.config.mcpServers = { a: { url: a.url }, b: { url: b.url }, unused: { url: "http://127.0.0.1:9/mcp" } };
			const ambient = path.join(f.cwd, "ambient.md");
			await Bun.write(ambient, "AMBIENT_RULE_MUST_NOT_LOAD");
			await Bun.write(path.join(f.cwd, "AGENTS.md"), "WORKSPACE_RULE_MUST_NOT_LOAD");
			await Bun.write(path.join(f.root, "AGENTS.md"), "PARENT_RULE_MUST_NOT_LOAD");
			const ambientSkill = path.join(f.cwd, ".agents/skills/ambient/SKILL.md");
			await Bun.write(
				ambientSkill,
				"---\nname: ambient\ndescription: AMBIENT_SKILL_MUST_NOT_LOAD\n---\nAMBIENT_BODY\n",
			);
			f.config.resources.instructions = [ambient];
			f.config.resources.skills = [ambientSkill];
			f.config.resources.appendSystem = [ambient];
			f.config.resources.systemPrompt = ambient;
			for (const [id, model, tools] of [
				["a", "primary", ["read", "write", "mcp_list", "mcp_call"]],
				["b", "second", ["read", "ls", "mcp_list", "mcp_call"]],
			] as const) {
				await Bun.write(path.join(f.cwd, `${id}.md`), `INSTRUCTION_ONLY_${id.toUpperCase()}`);
				await Bun.write(
					path.join(f.cwd, `skill-${id}/SKILL.md`),
					`---\nname: preset-${id}\ndescription: SKILL_DESCRIPTION_ONLY_${id.toUpperCase()}\n---\nSKILL_BODY_ONLY_${id.toUpperCase()}\n`,
				);
				const definition: PresetDefinition = {
					...builtinPreset("bare"),
					id,
					name: id,
					model: { default: model, allowed: [model] },
					resources: {
						instructions: [{ base: "workspace", path: `${id}.md` }],
						skills: [{ base: "workspace", path: `skill-${id}/SKILL.md` }],
						appendSystem: [],
					},
					tools: [...tools],
					mcpServers: [id],
				};
				await Bun.write(path.join(f.home, "presets", id, "preset.json"), JSON.stringify(definition));
			}
			f.respond(request => {
				const user = request.messages.findLastIndex(message => message.role === "user");
				const text = JSON.stringify(request.messages[user]?.content);
				const results = request.messages.slice(user + 1).filter(message => message.role === "tool").length;
				if (text.includes("A_TASK")) {
					if (results === 0) return { call: { name: "read", arguments: { path: "skill-a/SKILL.md" } } };
					if (results === 1)
						return { call: { name: "write", arguments: { path: "a-result.txt", content: "A_FILE" } } };
					if (results === 2)
						return { call: { name: "mcp_call", arguments: { server: "a", tool: "probe", arguments: {} } } };
				}
				if (text.includes("B_TASK")) {
					if (results === 0) return { call: { name: "read", arguments: { path: "skill-b/SKILL.md" } } };
					if (results === 1)
						return { call: { name: "mcp_call", arguments: { server: "b", tool: "probe", arguments: {} } } };
				}
				return { text: text.includes("A_RESUME") ? "A_RESUMED" : "PRESET_REPLY" };
			});
			const first = await f.run({
				preset: "a",
				approve: true,
				promptsBefore: ["A_HISTORY_ONLY"],
				action: "submit",
				command: "A_TASK",
			});
			expect(first.code, first.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "a-result.txt")).text()).toBe("A_FILE");
			expect(first.result.changes).toHaveLength(1);
			expect(first.result.mcp.map((server: { name: string }) => server.name)).toEqual(["a"]);
			expect(a.methods).toContain("tools/call");
			expect(b.methods).toEqual([]);
			expect(JSON.stringify(f.requests[0])).toContain("SKILL_DESCRIPTION_ONLY_A");
			expect(JSON.stringify(f.requests[0])).not.toContain("SKILL_BODY_ONLY_A");
			expect(JSON.stringify(f.requests)).toContain("SKILL_BODY_ONLY_A");
			for (const request of f.requests) {
				expect(JSON.stringify(request)).toContain("INSTRUCTION_ONLY_A");
				expect(JSON.stringify(request)).not.toMatch(
					/INSTRUCTION_ONLY_B|SKILL_DESCRIPTION_ONLY_B|SKILL_BODY_ONLY_B/,
				);
				expect(names(request)).toEqual(["mcp_call", "mcp_list", "read", "request_tool", "write"]);
			}
			expect(f.requestHeaders.every(header => header.authorization === "Bearer fake-local-key")).toBe(true);
			const aCount = f.requests.length;
			const second = await f.run({ preset: "b", approve: true, action: "submit", command: "B_TASK" });
			expect(second.code, second.stderr).toBe(0);
			expect(second.result.changes).toEqual([]);
			expect(second.result.mcp.map((server: { name: string }) => server.name)).toEqual(["b"]);
			expect(b.methods).toContain("tools/call");
			expect(second.result.stateSessionId).not.toBe(first.result.stateSessionId);
			expect(second.result.sessionFile).not.toBe(first.result.sessionFile);
			for (const request of f.requests.slice(aCount)) {
				expect(JSON.stringify(request)).toContain("INSTRUCTION_ONLY_B");
				expect(JSON.stringify(request)).not.toMatch(
					/INSTRUCTION_ONLY_A|SKILL_DESCRIPTION_ONLY_A|SKILL_BODY_ONLY_A|A_HISTORY_ONLY|A_TASK|MCP_RESULT_ONLY_A/,
				);
				expect(names(request)).toEqual(["ls", "mcp_call", "mcp_list", "read", "request_tool"]);
			}
			expect(JSON.stringify(f.requests.slice(aCount))).toContain("SKILL_BODY_ONLY_B");
			expect(f.requestHeaders.slice(aCount).every(header => header.authorization === "Bearer fake-second-key")).toBe(
				true,
			);
			const bCount = f.requests.length;
			const resumed = await f.run({
				preset: "a",
				resume: first.result.sessionFile,
				action: "submit",
				command: "A_RESUME",
			});
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.stateSessionId).toBe(first.result.stateSessionId);
			expect(resumed.result.changes).toEqual(first.result.changes);
			expect(resumed.result.stateDir).toBe(first.result.stateDir);
			expect(f.requests).toHaveLength(bCount + 1);
			const final = JSON.stringify(f.requests.at(-1));
			expect(final).toContain("A_HISTORY_ONLY");
			expect(final).toContain("SKILL_BODY_ONLY_A");
			expect(final).toContain("MCP_RESULT_ONLY_A");
			expect(final).not.toMatch(/INSTRUCTION_ONLY_B|SKILL_BODY_ONLY_B|B_TASK|MCP_RESULT_ONLY_B/);
			expect(f.requestHeaders.at(-1)?.authorization).toBe("Bearer fake-local-key");
			expect(JSON.stringify(f.requests)).not.toMatch(
				/AMBIENT_RULE_MUST_NOT_LOAD|AMBIENT_SKILL_MUST_NOT_LOAD|WORKSPACE_RULE_MUST_NOT_LOAD|PARENT_RULE_MUST_NOT_LOAD/,
			);
			const source = await Bun.file(first.result.sessionFile).text();
			const requestCount = f.requests.length;
			const wrongPreset = await f.run({ preset: "b", resume: first.result.sessionFile });
			expect(wrongPreset.code).not.toBe(0);
			expect(f.requests).toHaveLength(requestCount);
			expect(await Bun.file(first.result.sessionFile).text()).toBe(source);
		} finally {
			a.close();
			b.close();
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"chat and bare actual requests omit ambient workflow resources and retain separate conversations",
	async () => {
		const f = await fixture();
		try {
			const ambient = path.join(f.cwd, "ambient.md");
			await Bun.write(ambient, "AMBIENT_WORKFLOW_MUST_NOT_LOAD");
			f.config.resources.instructions = [ambient];
			f.config.resources.appendSystem = [ambient];
			const chat = await f.run({ preset: "chat", action: "submit", command: "CHAT_HISTORY_ONLY" });
			expect(chat.code, chat.stderr).toBe(0);
			expect(f.requests).toHaveLength(1);
			expect(names(f.requests[0]!)).toEqual([]);
			const bare = await f.run({ preset: "bare", action: "submit", command: "BARE_TASK" });
			expect(bare.code, bare.stderr).toBe(0);
			expect(f.requests).toHaveLength(2);
			expect(names(f.requests[1]!)).toContain("read");
			expect(names(f.requests[1]!)).toContain("write");
			expect(names(f.requests[1]!)).not.toContain("mcp_call");
			expect(JSON.stringify(f.requests[1])).not.toContain("CHAT_HISTORY_ONLY");
			expect(JSON.stringify(f.requests)).not.toContain("AMBIENT_WORKFLOW_MUST_NOT_LOAD");
			expect(bare.result.stateSessionId).not.toBe(chat.result.stateSessionId);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"fabricated disabled writes and unselected MCP names cannot execute inside a named preset",
	async () => {
		const f = await fixture();
		const unselected = remote("UNSELECTED");
		const selected = remote("SELECTED");
		try {
			f.config.permissions.allowNetwork = true;
			f.config.mcpServers = { unselected: { url: unselected.url }, selected: { url: selected.url } };
			await Bun.write(
				path.join(f.home, "presets/restricted/preset.json"),
				JSON.stringify({
					...builtinPreset("bare"),
					id: "restricted",
					name: "restricted",
					tools: ["read", "mcp_list", "mcp_call"],
					mcpServers: ["selected"],
				}),
			);
			f.callTools([
				{ name: "write", arguments: { path: "must-not-exist.txt", content: "FORBIDDEN" } },
				{ name: "mcp_call", arguments: { server: "unselected", tool: "probe", arguments: {} } },
			]);
			const run = await f.run({ preset: "restricted", approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "must-not-exist.txt")).exists()).toBe(false);
			expect(run.result.changes).toEqual([]);
			expect(unselected.methods).toEqual([]);
			expect(selected.methods).toEqual([]);
			expect(f.requests).toHaveLength(3);
			expect(names(f.requests[0]!)).not.toContain("write");
			expect(
				run.result.messages.filter(
					(message: { role: string; isError?: boolean }) => message.role === "toolResult" && message.isError,
				),
			).toHaveLength(2);
		} finally {
			unselected.close();
			selected.close();
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);
