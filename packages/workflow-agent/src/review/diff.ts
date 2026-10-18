import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { createTwoFilesPatch } from "diff";
import { parseReviewDiffSnapshot } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/diff";
import type { RunState } from "../runtime/state";
import { contained, Policy } from "../policy/policy";
import { digest } from "../storage";
import { Search } from "../search/search";

export type DiffStage = "staged" | "unstaged" | "untracked" | "base";
export interface ProductDiffFile {
	readonly path: string;
	readonly stage: DiffStage;
	readonly rawDiff: string;
	readonly linesAdded: number;
	readonly linesRemoved: number;
}
export interface ProductDiffSnapshot {
	readonly id: string;
	readonly capturedAt: string;
	readonly base?: string;
	readonly files: readonly ProductDiffFile[];
	readonly excluded: readonly { readonly path: string; readonly stage: DiffStage; readonly reason: string }[];
	readonly patch: string;
	readonly complete: boolean;
	readonly note: string;
}
interface Comparison {
	stage: DiffStage;
	paths: string[];
	oldEntries: Map<string, vcs.GitFileEntry>;
	newEntries?: Map<string, vcs.GitFileEntry>;
}
class OmittedFile extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}
const MAX_FILE_BYTES = 128_000;
const MAX_PATCH_BYTES = 96_000;
const MAX_FILES = 100;

async function blob(repo: VcsGitRepo, oid: string, signal?: AbortSignal): Promise<string> {
	const output = await repo.showBlob(oid, MAX_FILE_BYTES, signal);
	if (output.truncated) throw new OmittedFile("size");
	if (output.data.includes(0)) throw new OmittedFile("binary");
	return output.data.toString("utf8");
}

async function worktreeFile(target: string): Promise<{ text: string; mode: string } | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new OmittedFile("non-file");
		if (stat.size > MAX_FILE_BYTES) throw new OmittedFile("size");
		const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead > MAX_FILE_BYTES) throw new OmittedFile("size");
		const data = bytes.subarray(0, bytesRead);
		if (data.includes(0)) throw new OmittedFile("binary");
		return { text: data.toString("utf8"), mode: stat.mode & 0o111 ? "100755" : "100644" };
	} finally {
		await handle.close();
	}
}

/** Read-only comparisons deliberately render renames as add/delete. Reading each
 * approved path separately prevents a rename from importing a forbidden old blob.
 * Native diffNoIndex writes temporary blobs, so untracked files use the existing
 * diff library instead. No Git objects or index entries are written here. */
export async function collectProductDiff(
	state: Pick<RunState, "cwd" | "home" | "policy">,
	base?: string,
	signal?: AbortSignal,
	limits: { maxFiles?: number; maxBytes?: number } = {},
): Promise<ProductDiffSnapshot> {
	signal?.throwIfAborted();
	const revision = state.policy.revision;
	const repo = vcs.requireGit(state.cwd);
	const root = await fs.realpath(repo.info().repoRoot);
	const workspace = await fs.realpath(state.cwd);
	const scanPolicy = new Policy(workspace, { readRoots: [], writeRoots: [], allowNetwork: false });
	scanPolicy.protectedRoots = [state.home, ...state.policy.protectedRoots];
	const indexEntries = new Map(
		(await vcs.listGitFileEntries(repo, undefined, signal)).map(entry => [entry.path, entry]),
	);
	const excluded: { path: string; stage: DiffStage; reason: string }[] = [];
	const search = new Search(scanPolicy);
	const untracked: string[] = [];
	let offset = 0;
	do {
		const page = await search.find({ path: workspace, hidden: true, offset, limit: 1000 }, signal);
		for (const match of page.matches) {
			const name = path.relative(root, path.join(workspace, match.path));
			if (!indexEntries.has(name)) untracked.push(name);
		}
		if (offset === 0) {
			for (const [kind, count] of Object.entries(page.skipped))
				if (count && kind !== "excluded")
					excluded.push({
						path: `<scan:${count}>`,
						stage: "untracked",
						reason: kind === "symlinks" ? "symlink" : kind === "denied" ? "permission" : kind,
					});
		}
		if (page.nextOffset === null) break;
		offset = page.nextOffset;
		if (offset >= 10_000) {
			excluded.push({ path: "<scan>", stage: "untracked", reason: "scan-limit" });
			break;
		}
	} while (offset < 10_000);
	const fileMode = (await repo.configGet("core.filemode", signal)) !== "false";
	let resolvedBase: string | undefined;
	const comparisons: Comparison[] = [];
	if (base) {
		resolvedBase = (await repo.resolveRef(base, signal)) ?? undefined;
		if (!resolvedBase) throw new Error("本地基准不存在；请使用本地分支、提交或 HEAD。");
		const oldEntries = new Map(
			(await vcs.listGitFileEntries(repo, resolvedBase, signal)).map(entry => [entry.path, entry]),
		);
		comparisons.push({
			stage: "base",
			oldEntries,
			paths: [...new Set([...oldEntries.keys(), ...indexEntries.keys(), ...untracked])].sort(),
		});
	} else {
		const head = await repo.headSha(signal);
		const headEntries = new Map(
			(head ? await vcs.listGitFileEntries(repo, head, signal) : []).map(entry => [entry.path, entry]),
		);
		comparisons.push(
			{
				stage: "staged",
				oldEntries: headEntries,
				newEntries: indexEntries,
				paths: [...new Set([...headEntries.keys(), ...indexEntries.keys()])]
					.filter(name => {
						const a = headEntries.get(name),
							b = indexEntries.get(name);
						return a?.oid !== b?.oid || a?.mode !== b?.mode || (b?.stage ?? 0) !== 0;
					})
					.sort(),
			},
			{
				stage: "unstaged",
				oldEntries: indexEntries,
				paths: [...indexEntries.keys()].sort(),
			},
			{ stage: "untracked", oldEntries: new Map(), paths: untracked.sort() },
		);
	}
	const files: ProductDiffFile[] = [];
	const patches: string[] = [];
	const maxFiles = Math.max(1, Math.min(MAX_FILES, limits.maxFiles ?? MAX_FILES));
	const maxBytes = Math.max(1, Math.min(MAX_PATCH_BYTES, limits.maxBytes ?? MAX_PATCH_BYTES));
	let usedBytes = 0;
	for (const comparison of comparisons) {
		for (const [candidate, name] of comparison.paths.entries()) {
			signal?.throwIfAborted();
			state.policy.assertCurrent(revision);
			try {
				if (candidate >= 10_000) {
					excluded.push({ path: "<scan>", stage: comparison.stage, reason: "scan-limit" });
					break;
				}
				if (files.length >= maxFiles) throw new OmittedFile("file-limit");
				const oldEntry = comparison.oldEntries.get(name);
				const newEntry = comparison.newEntries?.get(name);
				if (oldEntry?.stage || newEntry?.stage) throw new OmittedFile("unmerged");
				if ([oldEntry?.mode, newEntry?.mode].includes("160000")) throw new OmittedFile("submodule");
				if ([oldEntry?.mode, newEntry?.mode].includes("120000")) throw new OmittedFile("symlink");
				if (/[\0\r\n\t]/.test(name)) throw new OmittedFile("unsupported-path");
				const absolute = path.resolve(root, name);
				if (!contained(root, absolute) || !contained(workspace, absolute)) throw new OmittedFile("permission");
				if (name.split(/[/\\]/).some(part => [".git", "node_modules", ".my-agent", ".cache"].includes(part)))
					throw new OmittedFile("excluded-directory");
				let target: string;
				try {
					target = await scanPolicy.resolvePath(absolute, "read");
					await state.policy.resolvePath(absolute, "read");
				} catch {
					throw new OmittedFile("permission");
				}
				if (target !== absolute) throw new OmittedFile("symlink");
				await state.policy.authorize({ tool: "project-diff", kind: "read", target }, signal);
				const before = oldEntry ? await blob(repo, oldEntry.oid, signal) : undefined;
				const working = comparison.newEntries ? undefined : await worktreeFile(target);
				const after = comparison.newEntries
					? newEntry
						? await blob(repo, newEntry.oid, signal)
						: undefined
					: working?.text;
				const oldMode = oldEntry?.mode;
				const newMode = comparison.newEntries
					? newEntry?.mode
					: working
						? !fileMode && oldMode
							? oldMode
							: working.mode
						: undefined;
				signal?.throwIfAborted();
				state.policy.assertCurrent(revision);
				if (before === after && oldMode === newMode) continue;
				const raw = createTwoFilesPatch(
					before === undefined ? "/dev/null" : `a/${name}`,
					after === undefined ? "/dev/null" : `b/${name}`,
					before ?? "",
					after ?? "",
					"",
					"",
					{ timeout: 200, maxEditLength: 10_000 },
				);
				if (raw === undefined) throw new OmittedFile("diff-complexity");
				const modeDiff =
					oldMode !== newMode
						? `${oldMode ? `old mode ${oldMode}\n` : ""}${newMode ? `new mode ${newMode}\n` : ""}`
						: "";
				const patchText = `diff --git ${JSON.stringify(`a/${name}`)} ${JSON.stringify(`b/${name}`)}\n${modeDiff}${raw.slice(raw.indexOf("--- "))}`;
				const parsed = parseReviewDiffSnapshot(patchText);
				if (parsed.excluded.length) throw new OmittedFile(parsed.excluded[0].reason);
				const file = parsed.files[0];
				if (!file) throw new OmittedFile("unsupported-path");
				const bytes = Buffer.byteLength(patchText);
				if (usedBytes + bytes > maxBytes) throw new OmittedFile("size");
				usedBytes += bytes;
				patches.push(patchText);
				files.push(
					Object.freeze({
						path: name,
						stage: comparison.stage,
						rawDiff: patchText,
						linesAdded: file.linesAdded,
						linesRemoved: file.linesRemoved,
					}),
				);
			} catch (error) {
				signal?.throwIfAborted();
				state.policy.assertCurrent(revision);
				const code = (error as NodeJS.ErrnoException).code;
				if (!(error instanceof OmittedFile) && !["EACCES", "EPERM", "ELOOP", "ENOENT"].includes(code ?? ""))
					throw error;
				excluded.push(
					Object.freeze({
						path: name,
						stage: comparison.stage,
						reason: error instanceof OmittedFile ? error.reason : "unreadable",
					}),
				);
			}
		}
	}
	const patchText = patches.join("");
	return Object.freeze({
		id: digest(patchText),
		capturedAt: new Date().toISOString(),
		base: resolvedBase,
		files: Object.freeze(files),
		excluded: Object.freeze(excluded),
		patch: patchText,
		complete: excluded.length === 0,
		note: "按原始内容逐文件比较；不保证多文件同时刻一致，不应用 Git attributes/换行转换，可能包含纯 CRLF/LF 差异。重命名显示为删除和新增。扫描遵守忽略规则，.git、node_modules、.my-agent、.cache 不在范围内；权限限制、二进制及超限内容列为未覆盖。",
	});
}
