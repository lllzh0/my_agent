import { createTwoFilesPatch } from "diff";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import { truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Request, Approval } from "../policy/policy";
import { redact } from "../storage";

const MAX_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_EXPANDED * 10;

export function formatPreviewText(text: string, lines = MAX_PREVIEW_LINES): string {
	const visible = truncateHead(replaceTabs(String(redact(sanitizeText(text)))), { maxLines: lines, maxBytes: 8_000 });
	return `${visible.content}${visible.truncated ? "\n…预览已截断" : ""}`;
}

/** Presentation only: approval continues to bind to the original request. */
export function formatApproval(request: Request, compact = false): string {
	const value = redact(request) as Request;
	const fields = value.parameters ?? {};
	let body: string;
	if (typeof fields.diff === "string") {
		const label =
			fields.previewKind === "create"
				? "创建新文件"
				: fields.previewKind === "overwrite"
					? "覆盖现有文件"
					: `替换${fields.replaceAll ? "全部匹配" : "一个匹配"} · 匹配片段差异（行号相对于片段）`;
		const diff = compact
			? fields.diff
					.split("\n")
					.filter(line => !/^(?:Index:|={3,}|--- |\+\+\+ )/.test(line))
					.join("\n")
			: fields.diff;
		body = [
			label,
			...(typeof fields.addedLines === "number" && typeof fields.removedLines === "number"
				? [
						`新增 ${fields.addedLines} 行 · 删除 ${fields.removedLines} 行${fields.replaceAll ? "（每个匹配片段）" : ""}`,
					]
				: []),
			...(fields.previewTruncated ? ["仅展示部分差异；未展示的内容也属于本次操作。"] : []),
			diff,
		].join("\n");
	} else if (value.tool === "edit" && typeof fields.before === "string" && typeof fields.after === "string") {
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
	return formatPreviewText(
		`批准 ${value.tool}\n${value.target}\n${value.review?.reason ? `${value.review.reason}\n` : ""}\n${body}`,
		compact ? PREVIEW_LIMITS.EXPANDED_LINES : MAX_PREVIEW_LINES,
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
		const choice = await select(formatApproval(request, true), [
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
