import { formatPatch, structuredPatch } from "diff";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import { truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";

/** Diff before bounding, so a long unchanged prefix cannot hide the change. */
export function changePreview(target: string, before: string | null, after: string, fragment = false) {
	const previewKind = fragment ? "replace" : before === null ? "create" : "overwrite";
	const patch = structuredPatch(target, target, before ?? "", after, "修改前", "修改后", { context: 3, timeout: 100 });
	if (!patch) return { previewKind, diff: "差异计算达到时间上限，请缩小本次修改后重试。", previewTruncated: true };
	let addedLines = 0;
	let removedLines = 0;
	for (const hunk of patch.hunks)
		for (const line of hunk.lines) {
			if (line.startsWith("+")) addedLines++;
			if (line.startsWith("-")) removedLines++;
		}
	const complete = patch.hunks.length ? formatPatch(patch) : "内容未改变。";
	const preview = truncateHead(complete, { maxLines: PREVIEW_LIMITS.OUTPUT_EXPANDED * 10, maxBytes: 8_000 });
	return {
		previewKind,
		diff: preview.content,
		addedLines,
		removedLines,
		previewTruncated: preview.truncated === true,
	};
}
