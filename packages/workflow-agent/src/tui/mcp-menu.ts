import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { RunState } from "../runtime/state";
import { parse } from "shell-quote";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { parseMcpConfig } from "../mcp/config";
import { saveConfig } from "../config/config";
import { record, redact } from "../storage";

export type McpMenuUI = Pick<ExtensionContext["ui"], "select" | "input" | "confirm" | "editor" | "notify">;
export async function mcpMenu(
	state: Pick<RunState, "home" | "config" | "mcp" | "preset">,
	ui: McpMenuUI,
	signal?: AbortSignal,
): Promise<void> {
	const show = async (title: string, value: unknown) => {
		await ui.editor(title, replaceTabs(JSON.stringify(redact(value), null, 2)));
	};
	try {
		const choice = await ui.select("MCP 外部工具", [
			"查看连接状态",
			"连接并查看工具",
			"断开连接",
			...(!state.preset ? ["添加远程 HTTP 服务", "添加本地 stdio 服务", "启用或停用服务（重启生效）"] : []),
			"返回",
		]);
		signal?.throwIfAborted();
		if (!choice || choice === "返回") return;
		if (choice === "查看连接状态") {
			await show("MCP 状态", {
				current: state.mcp.status(),
				nextStart: Object.keys(state.config.mcpServers),
				note: "配置不等于已连接。配置变更重启生效；连接和业务调用分别批准；MCP 修改不支持文件菜单撤销。",
			});
			return;
		}
		if (choice === "连接并查看工具" || choice === "断开连接") {
			const choices = state.mcp.status().filter(entry => !["disabled", "invalid"].includes(entry.status));
			if (!choices.length) {
				ui.notify("当前会话没有可用服务；可先添加，重启后连接。", "info");
				return;
			}
			const name = await ui.select(
				"当前会话中的服务",
				choices.map(entry => entry.name),
			);
			if (!name) return;
			if (choice === "断开连接") {
				await state.mcp.disconnect(name);
				ui.notify("连接已断开。", "info");
			} else await show("MCP 工具及参数", await state.mcp.list(name, signal));
			return;
		}
		if (state.preset)
			throw new Error("命名预设不修改共享 MCP 配置；请在 legacy 入口配置服务，再编辑预设中的服务引用并重新启动。");
		const next = structuredClone(state.config);
		if (choice === "启用或停用服务（重启生效）") {
			const names = Object.keys(next.mcpServers);
			if (!names.length) {
				ui.notify("还没有配置 MCP 服务。", "info");
				return;
			}
			const name = await ui.select("选择要切换的服务", names);
			if (!name) return;
			const current = record(next.mcpServers[name], "MCP 服务");
			const value = { ...current, enabled: current.enabled === false };
			if (value.enabled) parseMcpConfig(value);
			next.mcpServers[name] = value;
		} else {
			const name = (await ui.input("服务名称（字母、数字、点、下划线、短横线）"))?.trim();
			if (!name) return;
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error("服务名称无效，最多 64 位");
			if (
				Object.hasOwn(next.mcpServers, name) &&
				!(await ui.confirm("替换已配置服务", `将修改 ${name}，重启后生效。`))
			)
				return;
			let config: Record<string, unknown>;
			if (choice === "添加远程 HTTP 服务") {
				const url = (await ui.input("Streamable HTTP 服务地址（远程使用 HTTPS）"))?.trim();
				if (!url) return;
				const key = await ui.input("Bearer 认证环境变量名；无需认证请留空（不要输入密钥）");
				if (key === undefined) return;
				if (key && !/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("请输入环境变量名，不要输入密钥");
				config = {
					type: "http",
					url,
					enabled: true,
					...(key ? { headers: { Authorization: `Bearer \${${key}}` } } : {}),
				};
			} else {
				const command = (await ui.input("已安装程序的名称或路径（不会自动安装）"))?.trim();
				if (!command) return;
				const input = await ui.input("启动参数（支持引号；不支持管道、重定向、变量展开）");
				if (input === undefined) return;
				const args = parse(input, () => {
					throw new Error("启动参数不支持变量展开；凭据请使用环境变量引用");
				});
				if (!args.every(arg => typeof arg === "string")) throw new Error("启动参数不能包含管道、重定向或通配符");
				const key = await ui.input("传给服务的环境变量名（留空跳过；不要输入密钥）");
				if (key === undefined) return;
				if (key && !/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("请输入环境变量名，不要输入密钥");
				config = { type: "stdio", command, args, enabled: true, ...(key ? { env: { [key]: `\${${key}}` } } : {}) };
			}
			parseMcpConfig(config);
			next.mcpServers[name] = config;
		}
		signal?.throwIfAborted();
		await saveConfig(state.home, next);
		state.config = next;
		ui.notify("MCP 配置已保存，重启后生效；当前会话的服务选择不变。", "info");
	} catch (error) {
		ui.notify(replaceTabs(String(redact(error instanceof Error ? error.message : String(error)))), "error");
	}
}
