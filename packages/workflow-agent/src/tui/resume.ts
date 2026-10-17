import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import type { RunState } from "../runtime/state";
import { updateProductStatus } from "./permissions";

export async function resumeFromCommand(
	state: RunState,
	ctx: ExtensionContext,
	args: string,
	ensureIdle: () => void,
): Promise<void> {
	ensureIdle();
	if (state.jobs.hasActiveJobs) throw new Error("后台任务仍在运行或等待批准；先停止任务再恢复旧会话。");
	const controller = state.sessions;
	if (!controller) throw new Error("会话恢复尚未初始化。");
	const sessions = await controller.list();
	let selected: string | undefined;
	if (args) {
		const exact = sessions.filter(session => session.id === args);
		const matches = exact.length
			? exact
			: sessions.filter(session => session.id.toLowerCase().startsWith(args.toLowerCase()));
		if (!matches.length) throw new Error("当前工作区没有找到这个旧会话；使用 /resume 查看列表。");
		if (matches.length > 1) throw new Error("会话 ID 前缀对应多个会话，请输入更完整的 ID。");
		selected = matches[0].path;
	} else {
		if (!sessions.length) {
			ctx.ui.notify("当前工作区没有可恢复的旧会话。", "info");
			return;
		}
		if (!ctx.hasUI) throw new Error("请在交互终端使用 /resume，或明确输入 /resume 会话ID。");
		selected = await ctx.ui.custom<string | undefined>(
			(tui, _theme, _keys, done) => {
				const picker = new SessionSelectorComponent<SessionInfo>(
					sessions,
					session => done(session.path),
					() => done(undefined),
					() => done(undefined),
					{
						title: "恢复当前工作区的旧会话",
						scopeLabel: false,
						getTerminalRows: () => tui.terminal.rows,
					},
				);
				picker.setOnRequestRender(() => tui.requestRender());
				return picker;
			},
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" }, signal: ctx.signal },
		);
	}
	if (!selected) return;
	ensureIdle();
	const result = await controller.resume(selected, ctx.signal);
	updateProductStatus(state, ctx);
	ctx.ui.notify(
		result.refreshFailed
			? "旧会话和相关记录已恢复，授权已重置，但界面刷新失败；如显示异常，请退出后使用 --resume 重新打开该会话。"
			: "旧会话已恢复，聊天、任务、来源和文件修改记录已切换；授权按当前配置重新开始。",
		result.refreshFailed ? "warning" : "info",
	);
}
