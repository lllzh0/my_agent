import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "../config/config";
import { readJson, record } from "../storage";
import { BARE_TOOL_NAMES } from "../runtime/tool-catalog";
import { builtinPreset, presetId, readPreset, resolvePreset, validatePreset, type PresetDefinition } from "./presets";

export async function presetCommand(home: string, cwd: string, args: string[], template?: string): Promise<object> {
	const [command, id, ...extra] = args;
	if (extra.length) throw new Error("预设命令参数过多");
	if (command === "list" && !id) {
		const entries = await fs
			.readdir(path.join(home, "presets"), { withFileTypes: true })
			.catch((error: NodeJS.ErrnoException) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return [];
			});
		const ids = entries
			.filter(entry => entry.isDirectory() && !["chat", "bare", "legacy"].includes(entry.name))
			.map(entry => entry.name);
		const items = await Promise.all(
			ids.map(async name => {
				try {
					return { id: name, name: (await readPreset(home, name)).name, status: "configured" };
				} catch {
					return { id: name, status: "invalid" };
				}
			}),
		);
		return {
			presets: [
				{ id: "legacy", name: "原配置入口", status: "builtin" },
				{ id: "chat", name: "纯聊天", status: "builtin" },
				{ id: "bare", name: "空白工具", status: "builtin" },
				...items,
			],
		};
	}
	if (!id)
		throw new Error(
			"用法：agent preset list | create <ID> [--template coding|research|chat|bare] | show <ID> | check <ID>",
		);
	presetId(id);
	if (command === "create") {
		if (["legacy", "chat", "bare"].includes(id)) throw new Error("内置预设不能覆盖，请使用新的 ID");
		const kind = template ?? "coding";
		if (!["coding", "research", "chat", "bare"].includes(kind)) throw new Error("未知预设模板");
		const definition: PresetDefinition = { ...builtinPreset(kind === "chat" ? "chat" : "bare"), id, name: id };
		if (kind === "research")
			definition.tools = BARE_TOOL_NAMES.filter(
				name => !["bash", "job_output", "job_stop", "write", "edit", "goal"].includes(name),
			);
		const root = path.join(home, "presets");
		await fs.mkdir(root, { recursive: true, mode: 0o700 });
		const relative = path.relative(await fs.realpath(home), await fs.realpath(root));
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
			throw new Error("预设存储目录超出配置目录");
		const directory = path.join(root, id);
		await fs.mkdir(directory, { mode: 0o700 });
		const file = path.join(directory, "preset.json");
		await fs.writeFile(file, `${JSON.stringify(validatePreset(definition), null, 2)}\n`, { flag: "wx", mode: 0o600 });
		return {
			id,
			file,
			note: "模板不自动选择技能、指令或 MCP；编辑清单后用 preset check 检查引用，再以 --preset 启动。",
		};
	}
	if (!["show", "check"].includes(command)) throw new Error(`未知预设操作：${command}`);
	if (id === "legacy") return { id, config: path.join(home, "config.json"), note: "使用原有配置、会话与资源热开关。" };
	const source = record(
		await readJson(path.join(home, "config.json")),
		"请先运行 agent setup --defaults 创建模型与服务配置",
	);
	if (source.version !== 1 || !source.model || !source.permissions || !source.mcpServers)
		throw new Error("基础配置无效，请先运行 doctor 检查 config.json");
	const resolved = await resolvePreset(home, cwd, id, source as unknown as Config);
	return {
		scope: "references",
		identity: resolved.identity,
		definition: resolved.definition,
		effective: {
			light: resolved.light,
			modelKeys: [resolved.config.model, ...(resolved.config.models ?? [])].map(
				model => model.key ?? `${model.provider}/${model.id}`,
			),
			resources: resolved.config.resources,
			tools: resolved.definition.tools,
			mcpServers: Object.keys(resolved.config.mcpServers),
			permissions: resolved.config.permissions,
			sessionDirectory: resolved.sessionDir,
			agentDirectory: resolved.agentDir,
		},
		note: "仅校验清单、路径和连接引用；不连接模型/MCP，不代表技能内容有效或命令沙箱已验收。",
	};
}
