import * as path from "node:path";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ResourceSwitch } from "../runtime/live-resources";

const groups = [
	{ kind: "skill", title: "技能" },
	{ kind: "instruction", title: "指令文件" },
	{ kind: "system", title: "附加提示词" },
	{ kind: "tool", title: "工具" },
];

function singleLine(value: string): string {
	return replaceTabs(sanitizeText(value)).replace(/[\r\n]+/g, " ");
}

function status(entry: ResourceSwitch): string {
	if (!entry.enabled) return entry.active ? "! 已关闭 · 当前仍可用" : "○ 已关闭";
	return entry.active ? "● 可用" : "◐ 已开启 · 未生效";
}

/** Show saved selection and current availability separately, using actual runtime data. */
export function formatResourceStatus(entries: readonly ResourceSwitch[]): string {
	const available = entries.filter(entry => entry.active).length;
	const inactive = entries.filter(entry => entry.enabled && !entry.active).length;
	const disabled = entries.filter(entry => !entry.enabled).length;
	const lines = [
		`共 ${entries.length} 项资源 · ${available} 项可用 · ${inactive} 项已开启但未生效 · ${disabled} 项已关闭`,
		"",
	];
	const sections = [...groups];
	if (entries.some(entry => !groups.some(group => group.kind === entry.kind)))
		sections.push({ kind: "other", title: "其他资源" });
	for (const group of sections) {
		const items = entries.filter(entry =>
			group.kind === "other" ? !groups.some(known => known.kind === entry.kind) : entry.kind === group.kind,
		);
		lines.push(`${group.title} · ${items.filter(entry => entry.active).length} / ${items.length} 可用`);
		if (!items.length) lines.push("  尚未配置");
		if (group.kind === "tool") {
			for (const label of new Set(items.map(status))) {
				const names = items.filter(entry => status(entry) === label).map(entry => singleLine(entry.name));
				lines.push(`  ${label}  ${names.join(" · ")}`);
			}
			if (items.some(entry => entry.name === "goal" && entry.enabled && !entry.active))
				lines.push("  goal 已开启，进入目标模式后才可用。");
		} else {
			for (const entry of items) {
				const file = entry.kind === "instruction" || entry.kind === "system";
				const name = file ? path.basename(entry.name) : `${entry.kind === "skill" ? "$" : ""}${entry.name}`;
				lines.push(`  ${status(entry)}  ${singleLine(name)}`);
				if (file) lines.push(`    路径：${singleLine(shortenPath(entry.name))}`);
				// IDs remain exact for /resources on|off, including full paths for file resources.
				lines.push(`    ID：${singleLine(entry.id)}`);
			}
		}
		lines.push("");
	}
	lines.push(
		"使用说明",
		"  技能用 $名称 调用；可用表示已注册，技能正文会在需要时读取。",
		"  工具仍受当前授权和计划模式限制；已开启不代表可以跳过审批。",
		"  Esc 返回资源菜单调整开关；设置已保存，后续请求生效，已有聊天保留。",
		"  命令开关：/resources on <ID> 或 /resources off <ID>。工具 ID 为 tool:名称。",
	);
	return lines.join("\n");
}
