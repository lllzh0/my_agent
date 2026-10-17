import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	FileType,
	GrepOutputMode,
	ShellFsOp,
	glob,
	grep,
	search as nativeSearch,
	type GlobMatch,
	type GrepMatch,
	type ShellFilesystem,
	type ShellFsResponse,
} from "@oh-my-pi/pi-natives";
import { AbortError, untilAborted } from "@oh-my-pi/pi-utils/abortable";
import { contained, type Policy } from "../policy/policy.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const SEARCH_TIMEOUT_MS = 15_000;
// Native grep may search only a prefix above this size without reporting it.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_COLUMNS = 1000;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".my-agent", ".cache"]);
const READ_OPERATIONS = new Set([
	ShellFsOp.Metadata,
	ShellFsOp.SymlinkMetadata,
	ShellFsOp.ReadDir,
	ShellFsOp.Canonicalize,
	ShellFsOp.BackingPath,
	ShellFsOp.ReadLink,
	ShellFsOp.Access,
	ShellFsOp.Open,
]);

export interface SearchInput {
	/** A permitted directory or one explicit file, relative to the workspace. */
	path?: string;
	/** File-name glob; a simple pattern such as *.ts matches at any depth. */
	glob?: string;
	gitignore?: boolean;
	hidden?: boolean;
	/** Number of matching rows to skip. Pages assume files remain unchanged. */
	offset?: number;
	/** Returned rows, from 1 through 1000. Defaults to 100. */
	limit?: number;
}

export interface FindInput extends SearchInput {
	/** Alias for glob. Supply at most one distinct file-name pattern. */
	pattern?: string;
}

export interface GrepInput extends SearchInput {
	pattern: string;
	/** True searches exact text; false uses JS-compatible native regex syntax. */
	literal?: boolean;
	ignoreCase?: boolean;
}

export interface SearchSkipped {
	/** Distinct paths denied by Policy. Filesystem permission errors are unreadable. */
	denied: number;
	symlinks: number;
	excluded: number;
	oversized: number;
	unreadable: number;
}

export interface SearchPage {
	/** Canonical search root. Paths are relative to a directory root, or a file's basename. */
	path: string;
	offset: number;
	limit: number;
	/** True only when this page reaches the end with no unsearched content. */
	complete: boolean;
	/** More rows, skipped content, or shortened matching lines remain. */
	truncated: boolean;
	/** More matching rows were observed beyond this page. */
	limitReached: boolean;
	nextOffset: number | null;
	/** Lower bound when totalIsExact is false. */
	totalMatches: number;
	totalIsExact: boolean;
	skipped: SearchSkipped;
}

export interface FindResult extends SearchPage {
	matches: GlobMatch[];
}

export interface GrepResult extends SearchPage {
	matches: GrepMatch[];
	filesSearched: number;
}

interface SkippedPaths {
	denied: Set<string>;
	symlinks: Set<string>;
	excluded: Set<string>;
	oversized: Set<string>;
	unreadable: Set<string>;
}

interface SearchScope {
	root: string;
	base: string;
	files: GlobMatch[];
	skipped: SkippedPaths;
	filesystem: ShellFilesystem;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new AbortError(signal);
}

function pageOptions(input: SearchInput): { offset: number; limit: number } {
	const offset = input.offset ?? 0;
	const limit = input.limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff_ffff)
		throw new Error("offset 必须是 0 到 4294967295 的整数");
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
		throw new Error(`limit 必须是 1 到 ${MAX_LIMIT} 的整数`);
	return { offset, limit };
}

function skippedCounts(skipped: SkippedPaths): SearchSkipped {
	return {
		denied: skipped.denied.size,
		symlinks: skipped.symlinks.size,
		excluded: skipped.excluded.size,
		oversized: skipped.oversized.size,
		unreadable: skipped.unreadable.size,
	};
}

function page(
	scope: SearchScope,
	offset: number,
	limit: number,
	totalMatches: number,
	hasMore: boolean,
	shortened = false,
): SearchPage {
	const skipped = skippedCounts(scope.skipped);
	const unsearched = skipped.denied + skipped.symlinks + skipped.oversized + skipped.unreadable > 0;
	const truncated = hasMore || unsearched || shortened;
	return {
		path: scope.root,
		offset,
		limit,
		complete: !truncated,
		truncated,
		limitReached: hasMore,
		nextOffset: hasMore ? offset + limit : null,
		totalMatches,
		totalIsExact: !hasMore && !unsearched,
		skipped,
	};
}

export class Search {
	readonly #policy: Policy;

	constructor(policy: Policy) {
		this.#policy = policy;
	}

	async find(input: FindInput = {}, signal?: AbortSignal): Promise<FindResult> {
		const options = pageOptions(input);
		if (input.pattern && input.glob && input.pattern !== input.glob)
			throw new Error("find 的 pattern 与 glob 是同一个文件名筛选条件，请只提供一个");
		const operation = signal
			? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
			: AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		const scope = await this.#scope({ ...input, glob: input.glob ?? input.pattern }, operation);
		const matches: GlobMatch[] = [];
		let totalMatches = 0;
		for (const file of scope.files) {
			if (!(await this.#approvedFile(scope, file, operation))) continue;
			if (totalMatches >= options.offset && matches.length < options.limit) matches.push(file);
			totalMatches++;
		}
		throwIfAborted(operation);
		return {
			...page(scope, options.offset, options.limit, totalMatches, totalMatches > options.offset + matches.length),
			// File discovery counts all permitted results even when the page is smaller.
			totalIsExact: scope.skipped.denied.size + scope.skipped.symlinks.size + scope.skipped.unreadable.size === 0,
			matches,
		};
	}

	async grep(input: GrepInput, signal?: AbortSignal): Promise<GrepResult> {
		const options = pageOptions(input);
		const operation = signal
			? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
			: AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		throwIfAborted(operation);
		if (typeof input.pattern !== "string" || input.pattern.length === 0) throw new Error("grep 需要非空 pattern");
		const pattern = input.literal ? RegExp.escape(input.pattern) : input.pattern;
		// Native grep repairs invalid expressions and falls back to literal text.
		// Validate first so invalid input never becomes a misleading empty search.
		if (!input.literal) {
			try {
				RegExp(pattern, "u");
			} catch (error) {
				throw new Error("无效正则 pattern；普通文本请设置 literal: true", { cause: error });
			}
		}
		// The guaranteed alternative proves native compilation succeeded. Its
		// literal fallback cannot match this short probe, even for valid JS-only
		// syntax such as escaped group names or surrogate-pair escapes.
		const probe = "__MY_AGENT_NATIVE_REGEX_CHECK__";
		const validation = nativeSearch(probe, {
			pattern: `(?:${pattern})|(?:^${probe}$)`,
			ignoreCase: input.ignoreCase,
			maxCount: 1,
		});
		if (validation.error || validation.matches.length === 0)
			throw new Error("原生搜索引擎不支持此 pattern；请简化正则或使用 literal: true");
		const scope = await this.#scope(input, operation);
		const matches: GrepMatch[] = [];
		let remainingOffset = options.offset;
		let totalMatches = 0;
		let filesSearched = 0;
		let hasMore = false;
		for (const file of scope.files) {
			const target = await this.#approvedFile(scope, file, operation);
			if (!target) continue;
			const metadata = await untilAborted(operation, () => fs.stat(target));
			if (metadata.size > MAX_FILE_BYTES) {
				scope.skipped.oversized.add(target);
				continue;
			}
			throwIfAborted(operation);
			const result = await grep({
				path: target,
				pattern,
				ignoreCase: input.ignoreCase,
				mode: GrepOutputMode.Content,
				offset: remainingOffset,
				maxCount: options.limit - matches.length + 1,
				maxColumns: MAX_LINE_COLUMNS,
				signal: operation,
				filesystem: scope.filesystem,
			});
			throwIfAborted(operation);
			filesSearched += result.filesSearched;
			if (!result.filesSearched) {
				scope.skipped.unreadable.add(target);
				continue;
			}
			if (result.skippedOversized) scope.skipped.oversized.add(target);
			totalMatches += result.totalMatches;
			remainingOffset = Math.max(0, remainingOffset - result.totalMatches);
			for (const match of result.matches) {
				if (matches.length >= options.limit) {
					hasMore = true;
					break;
				}
				matches.push({ ...match, path: file.path });
			}
			if (hasMore) break;
		}
		throwIfAborted(operation);
		return {
			...page(
				scope,
				options.offset,
				options.limit,
				totalMatches,
				hasMore,
				matches.some(match => match.truncated),
			),
			matches,
			filesSearched,
		};
	}

	#excluded(target: string): boolean {
		return path
			.relative(this.#policy.workspace, target)
			.split(path.sep)
			.some(part => EXCLUDED_DIRECTORIES.has(part));
	}

	#filesystem(root: string, skipped: SkippedPaths, signal: AbortSignal): ShellFilesystem {
		return {
			// Route even ordinary host paths: native glob also reads ignore files.
			nativeLocalPaths: false,
			handler: async (_error, request): Promise<ShellFsResponse> => {
				const subject = request.path;
				if (!subject || !READ_OPERATIONS.has(request.op))
					return { error: { code: "EACCES", message: "搜索只允许读取" } };
				if (
					request.op === ShellFsOp.Open &&
					(!request.open?.read ||
						request.open.write ||
						request.open.append ||
						request.open.create ||
						request.open.truncate)
				)
					return { error: { code: "EACCES", message: "搜索只允许读取" } };
				try {
					throwIfAborted(signal);
					if (this.#excluded(subject)) {
						skipped.excluded.add(subject);
						return { error: { code: "EACCES", message: "搜索排除的目录" } };
					}
					const approved = await untilAborted(signal, () => this.#policy.resolvePath(subject, "read"));
					if (request.op === ShellFsOp.Open && (await fs.lstat(subject)).isSymbolicLink()) {
						skipped.symlinks.add(subject);
						return { error: { code: "EACCES", message: "搜索不读取符号链接" } };
					}
					throwIfAborted(signal);
					return { local: request.op === ShellFsOp.SymlinkMetadata ? subject : approved, readonly: true };
				} catch (error) {
					if (signal.aborted) return { error: { code: "ECANCELED", message: "搜索已取消" } };
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT" || code === "ENOTDIR") return { error: { code } };
					if (contained(root, subject)) {
						if (code === "EACCES" || code === "EPERM") skipped.unreadable.add(subject);
						else skipped.denied.add(subject);
					}
					return { error: { code: "EACCES", message: "路径读取未获许可" } };
				}
			},
		};
	}

	async #scope(input: SearchInput, signal: AbortSignal): Promise<SearchScope> {
		throwIfAborted(signal);
		const root = await untilAborted(signal, () => this.#policy.resolvePath(input.path ?? ".", "read"));
		if (this.#excluded(root)) throw new Error("目标属于搜索排除的目录");
		const metadata = await untilAborted(signal, () => fs.stat(root));
		if (!metadata.isFile() && !metadata.isDirectory()) throw new Error("搜索路径必须是普通文件或目录");
		const skipped: SkippedPaths = {
			denied: new Set(),
			symlinks: new Set(),
			excluded: new Set(),
			oversized: new Set(),
			unreadable: new Set(),
		};
		const filesystem = this.#filesystem(root, skipped, signal);
		const base = metadata.isDirectory() ? root : path.dirname(root);
		const discovered =
			metadata.isFile() && !input.glob
				? [{ path: path.basename(root), fileType: FileType.File, size: metadata.size }]
				: (
						await glob({
							path: base,
							pattern: input.glob ?? "*",
							hidden: input.hidden ?? false,
							gitignore: input.gitignore ?? true,
							cache: false,
							signal,
							filesystem,
						})
					).matches;
		throwIfAborted(signal);
		const files: GlobMatch[] = [];
		for (const entry of discovered) {
			const target = path.resolve(base, entry.path);
			if (metadata.isFile() && target !== root) continue;
			if (entry.fileType === FileType.Symlink) skipped.symlinks.add(target);
			else if (entry.fileType === FileType.File) files.push(entry);
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return { root, base, files, skipped, filesystem };
	}

	async #approvedFile(scope: SearchScope, file: GlobMatch, signal: AbortSignal): Promise<string | undefined> {
		throwIfAborted(signal);
		const candidate = path.resolve(scope.base, file.path);
		if (this.#excluded(candidate)) {
			scope.skipped.excluded.add(candidate);
			return undefined;
		}
		try {
			const target = await untilAborted(signal, () => this.#policy.resolvePath(candidate, "read"));
			const metadata = await untilAborted(signal, () => fs.lstat(candidate));
			if (metadata.isSymbolicLink()) scope.skipped.symlinks.add(candidate);
			else if (metadata.isFile()) return target;
			else scope.skipped.unreadable.add(candidate);
		} catch (error) {
			throwIfAborted(signal);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM") scope.skipped.unreadable.add(candidate);
			else scope.skipped.denied.add(candidate);
		}
		return undefined;
	}
}
