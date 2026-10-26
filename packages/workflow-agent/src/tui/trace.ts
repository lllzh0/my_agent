import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import type { RunState } from "../runtime/state";
import { compareTraceRequests } from "../diagnostics/trace-data";
import type { ModelTraceRecord } from "../diagnostics/model-trace";

const notice =
	"本地正文记录默认关闭，开启后可能保存提示词、代码、聊天和工具内容。每会话保留最近 100 条、每条最多 256 KiB；省略和未捕获内容会注明。开关仅本进程有效。记录主对话及会话旁问，不含独立审查、权限审核器或子代理；正文为供应商发送前的请求对象，后续协议转换与传输重试不保证完整。";

function summary(record: ModelTraceRecord): string {
	return `${record.id} · ${record.source === "main" ? "主请求" : "旁路请求"} · ${record.model.provider}/${record.model.id} · ${record.status} · ${record.durationMs ?? "?"}ms${record.truncated ? " · 有省略" : ""}`;
}

export async function traceFromCommand(state: RunState, ctx: ExtensionContext, args = ""): Promise<void> {
	const traces = state.traces;
	if (!traces) throw new Error("轨迹管理尚未初始化。");
	const parts = args.trim().split(/\s+/);
	const action = parts[0];
	const show = async (title: string, value: string) => {
		await ctx.ui.editor(title, replaceTabs(value));
	};
	if ((action === "on" || action === "off") && parts.length === 1) {
		traces.setEnabled(action === "on");
		await traces.flush();
		ctx.ui.notify(
			action === "on" ? `已开启模型轨迹记录。${notice}` : "已停止新增正文记录，已有本地记录保留。",
			"info",
		);
	} else if (action === "list" && parts.length === 1) {
		const records = await traces.list();
		await show(
			"模型请求轨迹",
			`${traces.enabled ? "记录开启" : "记录关闭"}\n${notice}\n\n${records.map(summary).join("\n") || "当前会话没有已记录请求。"}\n${traces.warning ?? ""}`,
		);
	} else if (action === "show" && parts.length === 2) {
		await show("模型请求详情", JSON.stringify(await traces.get(parts[1]), null, 2));
	} else if (action === "compare" && parts.length === 3) {
		const left = await traces.get(parts[1]);
		const right = await traces.get(parts[2]);
		await show(
			"模型请求差异",
			`${summary(left)}\n${summary(right)}\n${left.truncated || right.truncated ? "记录存在省略，比较仅覆盖保留部分。\n" : ""}捕获阶段：供应商发送前；后续协议转换与重试不保证完整。\n\n${compareTraceRequests(left.requests, right.requests)}`,
		);
	} else if (action) {
		throw new Error("用法：/trace [on|off|list|show <ID>|compare <ID-A> <ID-B>]");
	} else {
		if (!ctx.hasUI) throw new Error("非交互模式请使用 /trace 的 on、off、list、show 或 compare 子命令。");
		while (true) {
			const choice = await ctx.ui.select(`模型请求轨迹 · ${traces.enabled ? "开启" : "关闭"}`, [
				"查看请求列表",
				"查看一条请求",
				"比较两次请求",
				traces.enabled ? "停止记录" : "开启正文记录",
				"返回",
			]);
			ctx.signal?.throwIfAborted();
			if (!choice || choice === "返回") return;
			if (choice === "查看请求列表") await traceFromCommand(state, ctx, "list");
			else if (choice === "开启正文记录") {
				if (await ctx.ui.confirm("开启本地模型正文记录", notice)) await traceFromCommand(state, ctx, "on");
			} else if (choice === "停止记录") await traceFromCommand(state, ctx, "off");
			else {
				const records = await traces.list();
				if (!records.length) {
					ctx.ui.notify("当前会话没有已记录请求。", "info");
					continue;
				}
				const labels = records.map(record => replaceTabs(summary(record)));
				const a = await ctx.ui.select("选择请求", labels);
				if (!a) continue;
				const left = records[labels.indexOf(a)];
				if (choice === "查看一条请求") await traceFromCommand(state, ctx, `show ${left.id}`);
				else {
					const b = await ctx.ui.select("选择要对比的请求", labels);
					if (b) await traceFromCommand(state, ctx, `compare ${left.id} ${records[labels.indexOf(b)].id}`);
				}
			}
		}
	}
}
