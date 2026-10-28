import { createTwoFilesPatch } from "diff";
import type { Request, Approval } from "../policy/policy";
import type { Job } from "../processes/supervisor";
import { redact } from "../storage";

const MAX_PREVIEW_CHARS = 8_000;
const MAX_PREVIEW_LINES = 100;

function bounded(text: string, lines = MAX_PREVIEW_LINES): string {
	const rows = text.split("\n");
	const visible = rows.slice(0, lines).join("\n").slice(0, MAX_PREVIEW_CHARS);
	return visible.length < text.length ? `${visible}\n…预览已截断` : visible;
}

/** Presentation only: approval continues to bind to the original request. */
export function formatApproval(request: Request): string {
	const value = redact(request) as Request;
	const fields = value.parameters ?? {};
	let body: string;
	if (value.tool === "edit" && typeof fields.before === "string" && typeof fields.after === "string") {
		body = [
			`替换${fields.replaceAll ? "全部匹配" : "一个匹配"} · 以下为匹配片段差异`,
			createTwoFilesPatch(value.target, value.target, fields.before, fields.after, "修改前", "修改后", {
				context: 3,
			}),
			...(fields.previewTruncated ? ["原始替换片段较长，此处仅展示部分内容。"] : []),
		].join("\n");
	} else if (["write", "write_report"].includes(value.tool) && typeof fields.preview === "string") {
		body = `写入内容预览（不代表完整文件差异）\n${fields.preview}${fields.previewTruncated ? "\n…写入内容已截断" : ""}`;
	} else body = JSON.stringify(fields, null, 2);
	return bounded(
		`批准 ${value.tool}\n${value.target}\n${value.review?.reason ? `${value.review.reason}\n` : ""}\n${body}`,
	);
}

/** Inspecting or dismissing a preview never submits a permission decision. */
export async function chooseApproval(
	request: Request,
	select: (title: string, choices: string[]) => Promise<string | undefined>,
	inspect: (body: string) => Promise<void>,
): Promise<Approval> {
	const body = formatApproval(request);
	while (true) {
		const choice = await select(bounded(body, 12), [
			"仅本次允许",
			"允许本会话完全相同的请求",
			"拒绝",
			"查看修改详情（只读）",
		]);
		if (choice === "查看修改详情（只读）") {
			await inspect(body);
			continue;
		}
		return choice === "仅本次允许" ? "once" : choice === "允许本会话完全相同的请求" ? "session" : "deny";
	}
}

/** A collapsed result still exposes failure and useful output; full logs remain available. */
export function formatCommandResult(job: Job, expanded = false): string {
	const labels: Record<Job["status"], string> = {
		running: "运行中",
		succeeded: "成功",
		failed: "失败",
		cancelled: "已取消",
		timed_out: "已超时",
		interrupted: "已中断",
	};
	const header = `${labels[job.status]} · 退出码 ${job.exitCode ?? "未取得"} · 作业 ${job.id}`;
	const output = String(redact(job.log)).trim();
	return `${header}\n${output ? bounded(output, expanded ? MAX_PREVIEW_LINES : 6) : "（暂无命令输出）"}${job.dropped ? "\n较早输出已淘汰；日志游标可显示保留范围。" : ""}`;
}
