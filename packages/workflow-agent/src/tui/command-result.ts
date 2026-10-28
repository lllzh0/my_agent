import { replaceTabs } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Job } from "../processes/supervisor";
import { redact } from "../storage";

export interface CommandResultDetails {
	job?: Job;
	logPage?: { cursor: number; truncated: boolean };
}

function clean(text: string): string {
	return replaceTabs(String(redact(sanitizeText(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")))));
}

/** Shared by foreground results, background log pages and stopped jobs on both platforms. */
export function formatCommandOutput(text: string, expanded = false): string {
	const output = clean(text).trim();
	if (!output) return "（暂无命令输出）";
	const preview = truncateMiddle(output, {
		maxBytes: expanded ? 8_000 : 2_000,
		maxLines: expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED * 10 : PREVIEW_LIMITS.OUTPUT_COLLAPSED * 2,
		maxHeadLines: expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : 2,
		maxHeadBytes: expanded ? 2_000 : 500,
	});
	return `${preview.content}${preview.truncated ? `\n…预览已截断；${expanded ? "可用 job_output 按游标读取保留日志。" : "Ctrl+O 展开更多输出。"}` : ""}`;
}

/** Display only: never changes model-facing output, job state, or the original log cursor. */
export function formatCommandResult(job: Job, expanded = false, logPage?: CommandResultDetails["logPage"]): string {
	const labels: Record<Job["status"], string> = {
		running: "运行中",
		succeeded: "成功",
		failed: "失败",
		cancelled: "已取消",
		timed_out: "已超时",
		interrupted: "已中断",
	};
	const start = Date.parse(job.startedAt);
	const end = job.endedAt ? Date.parse(job.endedAt) : Number.NaN;
	const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : "";
	const command = truncateMiddle(clean(job.command), { maxBytes: 1_000, maxLines: PREVIEW_LIMITS.COLLAPSED_LINES });
	return [
		clean(
			`${labels[job.status]} · 退出码 ${job.exitCode ?? "未取得"}${duration ? ` · 用时 ${duration}` : ""} · 作业 ${job.id}`,
		),
		`目录：${clean(shortenPath(job.cwd))}`,
		`命令：${command.content}${command.truncated ? "\n…命令仅显示部分" : ""}`,
		...(logPage
			? [
					`日志游标 ${logPage.cursor} · ${logPage.truncated ? "请求起点已淘汰，仅显示保留部分" : "本次读取的日志片段"}`,
				]
			: []),
		formatCommandOutput(job.log, expanded),
		...(job.dropped ? ["较早输出已淘汰，无法通过展开恢复；job_output 只返回保留日志。"] : []),
	].join("\n");
}
