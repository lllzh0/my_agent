import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { RunState } from "../runtime/state";
import type { ApprovalMode } from "../policy/policy";

export function permissionLabel(mode: ApprovalMode): string {
	return mode === "full" ? "完整授权 · 无沙箱" : mode === "auto" ? "自动授权" : "手动授权";
}

export function updateProductStatus(state: RunState, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		"my-agent",
		`My Agent${state.preset ? ` · 预设 ${state.preset.id}` : ""} · ${state.light ? "轻量 · " : ""}${state.policy.mode === "plan" ? "计划" : "执行"} · ${permissionLabel(state.policy.approvalMode)}${state.models ? ` · ${state.models.current().key}` : ""}`,
	);
}

export async function selectPermissions(
	state: RunState,
	ctx: ExtensionContext,
	input: string,
	ensureIdle: () => void,
): Promise<void> {
	ensureIdle();
	if (state.jobs.hasActiveJobs) throw new Error("后台任务仍在运行或等待批准；先停止任务再切换授权方式");
	let mode: ApprovalMode;
	if (input) {
		if (input !== "manual" && input !== "auto" && input !== "full")
			throw new Error("用法：/permissions [manual|auto|full]");
		mode = input;
	} else {
		if (!ctx.hasUI) throw new Error("请明确输入 /permissions manual、auto 或 full");
		const labels = [
			"手动授权：逐项确认副作用",
			"自动授权：普通操作自动批准，高风险再询问",
			"完整授权：无需批准，可访问整台机器和网络，不使用命令沙箱",
		];
		const choice = await ctx.ui.select(`授权方式（当前：${permissionLabel(state.policy.approvalMode)}）`, labels);
		if (!choice) return;
		mode = choice === labels[0] ? "manual" : choice === labels[1] ? "auto" : "full";
	}
	ensureIdle();
	if (state.jobs.hasActiveJobs) throw new Error("后台任务正在运行，未切换授权方式");
	// A server launched in full mode must not survive a return to sandboxed mode.
	await Promise.all(state.mcp.status().map(entry => state.mcp.disconnect(entry.name)));
	ensureIdle();
	if (state.jobs.hasActiveJobs) throw new Error("后台任务正在运行，未切换授权方式");
	state.policy.setApprovalMode(mode);
	state.sandbox.fullAccess = mode === "full";
	updateProductStatus(state, ctx);
	ctx.ui.notify(
		mode === "full"
			? "本会话已完整授权：不再逐项批准，命令不使用沙箱，可访问工作区外文件和网络。重启后不会继承。"
			: mode === "auto"
				? "自动授权已启用：普通操作自动批准；高风险、判断不清或审核失败时询问你。审核会增加模型请求。"
				: "手动授权已启用：副作用需要逐项批准。",
		"info",
	);
}
