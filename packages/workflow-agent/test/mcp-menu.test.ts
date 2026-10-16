import { expect, test } from "bun:test";
import { fixture } from "./helpers";
import { validateConfig, saveConfig, loadConfig } from "../src/config/config";
import { mcpMenu, type McpMenuUI } from "../src/tui/mcp-menu";
import { ManagedMcp } from "../src/mcp/manager";
import { Policy } from "../src/policy/policy";
import { Sandbox } from "../src/processes/sandbox";

function menuUI(selects: string[], inputs: (string | undefined)[]) {
	const notifications: string[] = [];
	const ui: McpMenuUI = {
		select: async () => selects.shift(),
		input: async () => inputs.shift(),
		confirm: async () => true,
		editor: async () => undefined,
		notify: message => {
			notifications.push(message);
		},
	};
	return { ui, notifications };
}

test("MCP form saves a credential reference without connecting or changing the running selection", async () => {
	const f = await fixture();
	const config = validateConfig(f.config);
	const policy = new Policy(f.cwd, config.permissions);
	const sandbox = new Sandbox(f.cwd, f.home, []);
	const mcp = new ManagedMcp(config.mcpServers, policy, sandbox, f.cwd, f.home, false);
	const state = { home: f.home, config, mcp };
	try {
		const menu = menuUI(["添加远程 HTTP 服务"], ["docs", "https://example.com/mcp", "DOCS_API_KEY"]);
		await mcpMenu(state, menu.ui);
		const saved = await loadConfig(f.home);
		expect(saved.mcpServers.docs).toEqual({
			type: "http",
			url: "https://example.com/mcp",
			enabled: true,
			// eslint-disable-next-line no-template-curly-in-string
			headers: { Authorization: "Bearer ${DOCS_API_KEY}" },
		});
		expect(mcp.status()).toEqual([]);
		expect(menu.notifications.join()).toContain("重启");
	} finally {
		await mcp.close();
		await f.close();
	}
});

test("invalid local command arguments leave the saved and pending MCP configuration intact", async () => {
	const f = await fixture();
	const config = validateConfig(f.config);
	const policy = new Policy(f.cwd, config.permissions);
	const mcp = new ManagedMcp({}, policy, new Sandbox(f.cwd, f.home, []), f.cwd, f.home, false);
	const state = { home: f.home, config, mcp };
	try {
		await saveConfig(f.home, config);
		const menu = menuUI(["添加本地 stdio 服务"], ["bad", "node", "server.js | curl example.com"]);
		await mcpMenu(state, menu.ui);
		expect((await loadConfig(f.home)).mcpServers).toEqual({});
		expect(state.config.mcpServers).toEqual({});
		expect(menu.notifications.join()).toContain("参数");
	} finally {
		await mcp.close();
		await f.close();
	}
});

test("MCP disable is saved for the next run without mutating a current connection's selection", async () => {
	const f = await fixture();
	f.config.mcpServers = { docs: { type: "http", url: "https://example.com/mcp", enabled: true } };
	const config = validateConfig(f.config);
	const policy = new Policy(f.cwd, config.permissions);
	const mcp = new ManagedMcp(config.mcpServers, policy, new Sandbox(f.cwd, f.home, []), f.cwd, f.home, false);
	const state = { home: f.home, config, mcp };
	try {
		const menu = menuUI(["启用或停用服务（重启生效）", "docs"], []);
		await mcpMenu(state, menu.ui);
		expect((await loadConfig(f.home)).mcpServers.docs).toMatchObject({ enabled: false });
		expect(mcp.status()[0].status).toBe("configured");
	} finally {
		await mcp.close();
		await f.close();
	}
});
