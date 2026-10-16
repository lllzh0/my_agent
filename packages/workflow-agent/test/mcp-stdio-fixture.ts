import * as fs from "node:fs/promises";
import * as path from "node:path";

const [protectedFile, outside, network] = process.argv.slice(2);
async function succeeds(action: () => Promise<unknown>): Promise<boolean> {
	try {
		await action();
		return true;
	} catch {
		return false;
	}
}
for await (const line of console) {
	const request = JSON.parse(line) as { id?: string; method: string };
	if (request.id === undefined) continue;
	let result: unknown = {};
	if (request.method === "initialize")
		result = {
			protocolVersion: "2025-11-25",
			serverInfo: { name: "stdio-fixture", version: "1" },
			capabilities: { tools: {} },
		};
	if (request.method === "tools/list") result = { tools: [{ name: "probe", inputSchema: { type: "object" } }] };
	if (request.method === "tools/call") {
		const child = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		const probe = {
			pid: process.pid,
			child: child.pid,
			inherited: Boolean(process.env.PRODUCT_TEST_KEY),
			selected: process.env.SELECTED === "fake-local-key",
			protectedRead: await succeeds(() => fs.readFile(protectedFile)),
			credentialRead: await succeeds(() => fs.readFile(path.join(process.cwd(), ".env"))),
			outsideWrite: await succeeds(() => Bun.write(outside, "escape")),
			workspaceWrite: await succeeds(() => Bun.write("mcp-result.txt", "stdio-workspace-ok")),
			network: await succeeds(() => fetch(network, { signal: AbortSignal.timeout(500) })),
		};
		result = { content: [{ type: "text", text: JSON.stringify(probe) }], structuredContent: probe };
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
