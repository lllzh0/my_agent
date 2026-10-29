import * as path from "node:path";
import { presetId, resolvePreset } from "./presets";
import { copyPreset, listPresets, newPresetDraft, presetBaseConfig, savePresetDraft } from "./store";
import { presetDefaults, setPresetDefault } from "./defaults";

export async function presetCommand(
	home: string,
	cwd: string,
	args: string[],
	template?: string,
	clear = false,
): Promise<object> {
	const [command, id, ...extra] = args;
	if (clear && (command !== "default" || id)) throw new Error("--clear 仅用于 preset default --clear");
	if (["copy", "clone"].includes(command)) {
		if (!id || extra.length !== 1) throw new Error("用法：agent preset copy <来源 ID> <新 ID>");
		await copyPreset(home, cwd, id, extra[0]);
		return { source: id, id: extra[0], note: "仅复制定义，继续引用原资源；不复制历史、凭据或临时授权。" };
	}
	if (extra.length) throw new Error("预设命令参数过多");
	if (command === "default" || command === "bind" || command === "unbind") {
		if (command === "default" && !id && !clear) return presetDefaults(home, cwd);
		if ((command === "bind" && !id) || (command === "unbind" && id))
			throw new Error("用法：preset bind <ID> | unbind");
		await setPresetDefault(
			home,
			cwd,
			command === "default" ? "global" : "workspace",
			clear || command === "unbind" ? undefined : id,
		);
		return {
			scope: command === "default" ? "global" : "workspace",
			preset: clear || command === "unbind" ? null : id,
			note: "仅影响后续启动；当前会话保持不变。",
		};
	}
	if (command === "list" && !id) {
		return { presets: await listPresets(home) };
	}
	if (!id)
		throw new Error(
			"用法：agent preset list | create <ID> [--template coding|research|chat|bare] | copy <来源> <新 ID> | show/check/bind/default <ID> | unbind | default --clear",
		);
	presetId(id);
	if (command === "create") {
		const draft = newPresetDraft(id, template);
		await savePresetDraft(home, cwd, draft);
		return {
			id,
			file: path.join(home, "presets", id, "preset.json"),
			note: "模板不自动选择资源；启动后使用 /preset edit 编辑，再以 --preset 启动。",
		};
	}
	if (!["show", "check"].includes(command)) throw new Error(`未知预设操作：${command}`);
	if (id === "legacy") return { id, config: path.join(home, "config.json"), note: "使用原有配置、会话与资源热开关。" };
	const resolved = await resolvePreset(home, cwd, id, await presetBaseConfig(home));
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
