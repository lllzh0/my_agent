import { truncateToWidth, visibleWidth, type ViewportSize } from "@oh-my-pi/pi-tui";
import type { ComposerFrameDecoration, ComposerFrameInsets } from "@oh-my-pi/pi-tui/prompt/composer";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export interface InkSnapshot {
	workspace: string;
	session: string;
	model: string;
	status: string;
	permission: string;
	trace: boolean;
	sessions: readonly string[];
	skills: readonly string[];
	tools: number;
	queued: number;
}

/** No runtime work or I/O while painting: the owner supplies a current snapshot. */
export class InkLayout implements ComposerFrameDecoration {
	sidebar = true;
	constructor(readonly snapshot: () => InkSnapshot) {}
	measure({ columns, rows }: ViewportSize): ComposerFrameInsets {
		return { top: rows >= 10 ? 2 : 0, left: this.sidebar && columns >= 100 && rows >= 16 ? 24 : 0 };
	}
	render(viewport: ViewportSize, content: readonly string[], insets: ComposerFrameInsets): readonly string[] {
		const state = this.snapshot();
		const clean = (value: string, width: number) =>
			truncateToWidth(sanitizeText(value).replace(/\s+/g, " "), Math.max(1, width));
		const header = insets.top
			? [
					theme.fg(
						"accent",
						clean(
							` MY AGENT / 墨线 · ${state.status}${state.queued ? ` · 排队 ${state.queued}` : ""}   ${state.workspace} / ${state.model}`,
							viewport.columns,
						),
					),
					theme.fg("dim", "─".repeat(Math.max(1, viewport.columns))),
				]
			: [];
		const rail = [
			"工作区",
			` ${state.workspace}`,
			"",
			"F2  会话",
			`› ${state.session}`,
			...state.sessions.slice(0, 3).map(name => `  ${name}`),
			"",
			"F3  资源与工具",
			`  ${state.tools} 个工具可用`,
			"",
			"$   技能",
			...state.skills.slice(0, 3).map(name => `  $${name}`),
			...(state.skills.length ? [] : ["  暂无启用技能"]),
			"",
			"Ctrl+P  操作面板",
			"Ctrl+O  执行记录",
			"",
			state.permission,
			`Trace ${state.trace ? "开启 · 本地记录" : "关闭"}`,
		];
		const lines = Array.from({ length: Math.max(0, viewport.rows - insets.top) }, (_, index) => {
			if (!insets.left) return content[index] ?? "";
			const label = clean(rail[index] ?? "", insets.left - 3);
			return `${theme.fg(index === 3 || index === 4 ? "accent" : "dim", ` ${label}${" ".repeat(Math.max(0, insets.left - 3 - visibleWidth(label)))}`)}${theme.fg("dim", "│ ")}${content[index] ?? ""}`;
		});
		return [...header, ...lines];
	}
}
