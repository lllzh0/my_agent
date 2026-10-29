import { expect, test } from "bun:test";
import * as path from "node:path";
import { fixture, HOST_TEST_TIMEOUT } from "./helpers";
import { sourceMcpFixture } from "./source-mcp-fixture";

interface ToolMessage {
	role: string;
	toolName?: string;
	isError?: boolean;
	content: { text: string }[];
}

test(
	"real product tools import host-issued MCP evidence and retain citations through session resume",
	async () => {
		const f = await fixture();
		const remote = sourceMcpFixture();
		let capturedId = "";
		try {
			f.config.permissions.allowNetwork = true;
			f.config.mcpServers = { fixture: { url: remote.url, researchTools: { retrieve: "content" } } };
			f.callTools([]);
			f.respond(request => {
				const results = request.messages.filter(message => message.role === "tool");
				if (!results.length)
					return {
						call: {
							name: "mcp_call",
							arguments: {
								server: "fixture",
								tool: "retrieve",
								arguments: { text: `${"a".repeat(12_000)}HOST_MCP_FACT` },
							},
						},
					};
				if (results.length === 1) {
					const content = results[0].content;
					const text = typeof content === "string" ? content : (content as { text: string }[])[0].text;
					capturedId = (JSON.parse(text) as { resultId: string }).resultId;
					return { call: { name: "import_mcp_source", arguments: { resultId: capturedId } } };
				}
				if (results.length === 2)
					return { call: { name: "read_source", arguments: { sourceId: "S1", offset: 12_001 } } };
				if (results.length === 3)
					return { call: { name: "search_source", arguments: { sourceId: "S1", query: "HOST_MCP_FACT" } } };
				if (results.length === 4)
					return {
						call: {
							name: "write_report",
							arguments: { path: "report.md", claims: [{ text: "Captured local MCP fact", sourceIds: ["S1"] }] },
						},
					};
				return { text: "Evidence saved" };
			});
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			const outputs = run.result.messages.filter(
				(message: ToolMessage) => message.role === "toolResult",
			) as ToolMessage[];
			expect(outputs).toHaveLength(5);
			expect(outputs.filter(output => output.isError)).toEqual([]);
			expect(JSON.parse(outputs[2].content[0].text).text).toContain("HOST_MCP_FACT");
			expect(JSON.parse(outputs[2].content[0].text).text).toContain('"endpoint":"none"');
			expect(JSON.parse(outputs[3].content[0].text).matches[0].offset).toBe(12_001);
			expect(await Bun.file(path.join(f.cwd, "report.md")).text()).toContain("外部 MCP fixture/retrieve");
			expect(remote.calls).toBe(1);
			f.respond(() => ({ text: "Resumed without refetching" }));
			const resumed = await f.run({ resume: run.result.sessionFile, action: "commands", commands: ["/session"] });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(JSON.parse(resumed.result.displays[0].text).storage.sources.sourceCount).toBe(1);
			expect(remote.calls).toBe(1);
			expect(capturedId).toMatch(/^MCP-/);
		} finally {
			remote.close();
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);
