import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { toolFixture } from "./tool-fixture";

test("discovery serializes edit's callable schema so a disabled edit can be prepared correctly", async () => {
	const f = await toolFixture();
	try {
		const discovery = f.tools.find(tool => tool.name === "request_tool")!;
		const output = await discovery.execute(
			"describe",
			{ tool: "edit" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = output.content.find(item => item.type === "text");
		if (text?.type !== "text") throw new Error("missing edit descriptor");
		const descriptor = JSON.parse(text.text);
		expect(descriptor.parameters?.type).toBe("object");
		expect(descriptor.parameters?.properties?.path?.type).toBe("string");
		expect(descriptor.parameters?.required).toContain("old_string");
	} finally {
		await f.close();
	}
});

test("discovery exposes no native tools or unselected MCP servers and does not approve execution", async () => {
	const f = await toolFixture();
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const discovery = f.tools.find(tool => tool.name === "request_tool")!;
		const output = await discovery.execute("list", {}, undefined, undefined, {} as ExtensionContext);
		const text = output.content.find(item => item.type === "text");
		if (text?.type !== "text") throw new Error("missing discovery list");
		const entries = JSON.parse(text.text) as { name: string }[];
		expect(entries.some(item => item.name === "write")).toBe(true);
		for (const name of ["task", "goal", "mcp_call", "request_tool"])
			expect(entries.some(item => item.name === name)).toBe(false);
		expect(f.state.toolAccess!.allows("write")).toBe(false);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
});
