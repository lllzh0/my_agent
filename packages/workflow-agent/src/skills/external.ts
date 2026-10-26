// Source-root and bounded discovery policies adapted from ZCode (Apache-2.0):
// packages/services/src/settings-sync/settingsSyncService.ts,
// packages/services/src/skills/skillDiscoveryWalk.ts, packages/shared/src/skill-scan-policy.ts.
// Product-specific selection, validation and transactional activation are implemented here.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { RunState } from "../runtime/state";
import { digest } from "../storage";

const { constants } = fs;

export interface ExternalSkillRoot {
	label: string;
	path: string;
}
export interface ExternalSkillCandidate {
	id: string;
	root: string;
	directory: string;
	directoryName: string;
	name: string;
	description: string;
	version?: string;
}
export interface SkillDiagnostic {
	path: string;
	message: string;
}
export interface ExternalSkillDiscovery {
	roots: ExternalSkillRoot[];
	candidates: ExternalSkillCandidate[];
	diagnostics: SkillDiagnostic[];
	truncated: boolean;
}
export interface ExternalSkillResult {
	id: string;
	name: string;
	path: string;
	status: "imported" | "skipped" | "failed";
	message: string;
}
export interface ExternalSkillImportResult {
	results: ExternalSkillResult[];
}
export type SkillImportMode = "copy" | "link";

const excludedDirectories = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	"coverage",
	".cache",
	".next",
	".turbo",
	".venv",
	"__pycache__",
]);
const maxScanEntries = 10_000;
const maxSkillBytes = 50_000_000;
const maxSkillFiles = 10_000;
const maxSkillDepth = 32;

export function externalSkillRoots(home: string, cwd?: string): ExternalSkillRoot[] {
	const sources = [
		["Claude Code", ".claude/skills"],
		["Codex CLI", ".codex/skills"],
		["OpenCode", ".config/opencode/skills", ".opencode/skills"],
		["OpenClaw", ".openclaw/skills", "skills"],
		["Augment", ".augment/skills"],
		["Continue", ".continue/skills"],
		["Goose", ".config/goose/skills", ".goose/skills"],
		["Qwen Code", ".qwen/skills"],
		["Qoder", ".qoder/skills"],
		["Qoder CN", ".qoder-cn/skills", ".qoder/skills"],
		["Windsurf", ".codeium/windsurf/skills", ".windsurf/skills"],
		["Trae", ".trae/skills"],
		["Trae CN", ".trae-cn/skills", ".trae/skills"],
		["Kiro CLI", ".kiro/skills"],
		["Roo Code", ".roo/skills"],
		["CodeBuddy", ".codebuddy/skills"],
		["Agents", ".agents/skills"],
	];
	const roots: ExternalSkillRoot[] = [];
	for (const [label, global, project] of sources) {
		roots.push({ label: `${label} · 用户`, path: path.resolve(home, global) });
		if (cwd) roots.push({ label: `${label} · 项目`, path: path.resolve(cwd, project ?? global) });
	}
	return roots.filter((root, index) => roots.findIndex(other => other.path === root.path) === index);
}
function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

async function metadata(directory: string): Promise<{ name: string; description: string; version?: string }> {
	const file = path.join(directory, "SKILL.md");
	const stat = await fs.stat(file);
	if (!stat.isFile() || stat.size > 1_000_000) throw new Error("SKILL.md 必须是小于 1MB 的普通文件。");
	if (!inside(directory, await fs.realpath(file))) throw new Error("SKILL.md 链接越过技能目录。");
	const content = await Bun.file(file).slice(0, 1_000_001).text();
	if (Buffer.byteLength(content) > 1_000_000) throw new Error("SKILL.md 超过 1MB 上限。");
	const { frontmatter } = parseFrontmatter(content, { source: file, level: "fatal" });
	const name =
		typeof frontmatter.name === "string" && frontmatter.name.trim()
			? frontmatter.name.trim()
			: path.basename(directory);
	if (!name || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") throw new Error("技能名称无效。");
	if (frontmatter.enabled === false) throw new Error("来源技能标记为 enabled: false。");
	if (typeof frontmatter.description !== "string" || !frontmatter.description.trim())
		throw new Error("技能缺少 description 说明。");
	return {
		name,
		description: frontmatter.description.trim(),
		...(typeof frontmatter.version === "string" ? { version: frontmatter.version } : {}),
	};
}

/** Discovery reads local files only. It never changes resource selection. */
export async function discoverExternalSkills(options: {
	home: string;
	cwd?: string;
	roots?: ExternalSkillRoot[];
	signal?: AbortSignal;
}): Promise<ExternalSkillDiscovery> {
	const result: ExternalSkillDiscovery = {
		roots: options.roots ?? externalSkillRoots(options.home, options.cwd),
		candidates: [],
		diagnostics: [],
		truncated: false,
	};
	const seen = new Set<string>();
	let count = 0;
	let metadataCharacters = 0;
	for (const source of result.roots) {
		options.signal?.throwIfAborted();
		let root: string;
		try {
			root = await fs.realpath(source.path);
		} catch (error) {
			if (!isEnoent(error)) result.diagnostics.push({ path: source.path, message: errorMessage(error) });
			continue;
		}
		const stack = [{ directory: root, depth: 0 }];
		while (stack.length) {
			options.signal?.throwIfAborted();
			const current = stack.pop()!;
			try {
				const directory = await fs.realpath(current.directory);
				if (!inside(root, directory)) throw new Error("目录链接越过扫描来源，已跳过。");
				if (seen.has(directory)) continue;
				seen.add(directory);
				const entries = await fs.readdir(directory, { withFileTypes: true });
				count += entries.length;
				if (count > maxScanEntries) {
					result.truncated = true;
					result.diagnostics.push({ path: directory, message: "扫描达到 10000 项上限，剩余目录未扫描。" });
					return result;
				}
				if (entries.some(entry => entry.name === "SKILL.md")) {
					try {
						const info = await metadata(directory);
						metadataCharacters += info.name.length + info.description.length + (info.version?.length ?? 0);
						if (metadataCharacters > 10_000_000) {
							result.truncated = true;
							result.diagnostics.push({ path: directory, message: "技能说明达到 10MB 上限，剩余目录未扫描。" });
							return result;
						}
						result.candidates.push({
							id: digest(`${root}\n${directory}`),
							root,
							directory,
							directoryName: path.basename(directory),
							...info,
						});
					} catch (error) {
						result.diagnostics.push({ path: path.join(directory, "SKILL.md"), message: errorMessage(error) });
					}
				}
				for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
					if (excludedDirectories.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".system"))
						continue;
					if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
					if (entry.isSymbolicLink()) {
						try {
							if (!(await fs.stat(path.join(directory, entry.name))).isDirectory()) continue;
						} catch (error) {
							result.diagnostics.push({ path: path.join(directory, entry.name), message: errorMessage(error) });
							continue;
						}
					}
					if (current.depth >= 8) {
						result.truncated = true;
						result.diagnostics.push({ path: directory, message: "扫描达到 8 层深度，子目录未扫描。" });
						continue;
					}
					stack.push({ directory: path.join(directory, entry.name), depth: current.depth + 1 });
				}
			} catch (error) {
				result.diagnostics.push({ path: current.directory, message: errorMessage(error) });
			}
		}
	}
	return result;
}

interface TreeEntry {
	relative: string;
	kind: "directory" | "file" | "link";
	target?: string;
	mode: number;
	size?: number;
	directoryLink?: boolean;
}

/** Inventory every support file; discovery exclusions do not discard imported content. */
async function inventory(directory: string, signal?: AbortSignal): Promise<TreeEntry[]> {
	const entries: TreeEntry[] = [];
	const stack = [{ relative: "", depth: 0 }];
	let bytes = 0;
	while (stack.length) {
		signal?.throwIfAborted();
		const current = stack.pop()!;
		const file = path.join(directory, current.relative);
		const stat = await fs.lstat(file);
		if (entries.length >= maxSkillFiles || current.depth > maxSkillDepth)
			throw new Error("技能超过 10000 项或 32 层上限。");
		if (stat.isSymbolicLink()) {
			const target = await fs.realpath(file);
			if (!inside(directory, target) || inside(target, path.dirname(file)))
				throw new Error(`技能包含越界或循环链接：${current.relative}`);
			entries.push({
				relative: current.relative,
				kind: "link",
				target: path.relative(directory, target),
				mode: stat.mode,
				directoryLink: (await fs.stat(file)).isDirectory(),
			});
		} else if (stat.isDirectory()) {
			if (!inside(directory, await fs.realpath(file))) throw new Error("技能目录发生变化或越界。");
			entries.push({ relative: current.relative, kind: "directory", mode: stat.mode });
			for (const name of await fs.readdir(file))
				stack.push({ relative: path.join(current.relative, name), depth: current.depth + 1 });
		} else if (stat.isFile()) {
			bytes += stat.size;
			if (bytes > maxSkillBytes) throw new Error("技能总大小超过 50MB 上限。");
			entries.push({ relative: current.relative, kind: "file", mode: stat.mode, size: stat.size });
		} else throw new Error(`技能包含非常规文件：${current.relative}`);
	}
	// A directory link can form a cycle through a sibling, not only an ancestor.
	const edges = new Map<string, string[]>();
	for (const entry of entries) {
		if (entry.relative && (entry.kind === "directory" || entry.directoryLink)) {
			const parent = path.dirname(entry.relative) === "." ? "" : path.dirname(entry.relative);
			const children = edges.get(parent) ?? [];
			children.push(entry.directoryLink ? entry.target! : entry.relative);
			edges.set(parent, children);
		}
	}
	const active = new Set<string>();
	const done = new Set<string>();
	const visit = (directory: string, depth: number): void => {
		if (active.has(directory)) throw new Error("技能包含循环目录链接。");
		if (done.has(directory)) return;
		if (depth > maxSkillDepth) throw new Error("技能链接路径超过 32 层上限。");
		active.add(directory);
		for (const child of edges.get(directory) ?? []) visit(child, depth + 1);
		active.delete(directory);
		done.add(directory);
	};
	visit("", 0);
	return entries;
}

async function copyTree(
	source: string,
	destination: string,
	entries: TreeEntry[],
	signal?: AbortSignal,
): Promise<void> {
	for (const entry of entries) {
		signal?.throwIfAborted();
		const from = path.join(source, entry.relative);
		const to = path.join(destination, entry.relative);
		if (entry.kind === "directory") {
			if (entry.relative) await fs.mkdir(to, { mode: 0o700 });
		} else if (entry.kind === "link") {
			const target = path.join(destination, entry.target!);
			const type = process.platform === "win32" && entry.directoryLink ? "junction" : undefined;
			await fs.symlink(type === "junction" ? target : path.relative(path.dirname(to), target), to, type);
		} else {
			if (!inside(source, await fs.realpath(from))) throw new Error("复制时来源文件发生变化或越界。");
			const input = await fs.open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const stat = await input.stat();
				if (!stat.isFile() || stat.size !== entry.size)
					throw new Error("复制时来源文件大小或类型已变化，请重新扫描。");
				const output = await fs.open(to, "wx", entry.mode & 0o777);
				try {
					let remaining = stat.size;
					const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(remaining, 1)));
					while (remaining > 0) {
						signal?.throwIfAborted();
						const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining));
						if (!bytesRead) throw new Error("复制时来源文件已缩短，请重新扫描。");
						let written = 0;
						while (written < bytesRead)
							written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
						remaining -= bytesRead;
					}
				} finally {
					await output.close();
				}
			} finally {
				await input.close();
			}
		}
	}
}

/** Explicit selection is authorization to activate only those individual SKILL.md files. */
export async function importExternalSkills(
	state: RunState,
	discovery: ExternalSkillDiscovery,
	ids: readonly string[],
	mode: SkillImportMode = "copy",
	signal?: AbortSignal,
): Promise<ExternalSkillImportResult> {
	signal?.throwIfAborted();
	if (mode !== "copy" && mode !== "link") throw new Error("导入方式必须为 copy 或 link。");
	const selected = [...new Set(ids)].map(id => {
		const candidate = discovery.candidates.find(item => item.id === id);
		if (
			!candidate ||
			candidate.id !== digest(`${candidate.root}\n${candidate.directory}`) ||
			!inside(candidate.root, candidate.directory) ||
			candidate.directoryName !== path.basename(candidate.directory) ||
			candidate.directoryName === "." ||
			candidate.directoryName === ".."
		)
			throw new Error(`未知或无效技能 ID：${id}`);
		return candidate;
	});
	const live = state.liveResources;
	if (!live) throw new Error("资源管理尚未初始化。");
	return live.withTransaction(async apply => {
		signal?.throwIfAborted();
		if (!selected.length) return { results: [] };
		const targetRoot = path.join(state.home, "skills");
		try {
			const targetStat = await fs.lstat(targetRoot);
			if (!targetStat.isDirectory() || targetStat.isSymbolicLink())
				throw new Error("托管技能目录必须是普通目录，不能是链接。");
		} catch (error) {
			if (!isEnoent(error)) throw error;
			await fs.mkdir(targetRoot, { mode: 0o700 });
		}
		// Previously linked imports can remain on disk after a config edit. Include
		// their roots explicitly so their names still reserve a conflict slot.
		const managedEntries = await fs.readdir(targetRoot, { withFileTypes: true });
		if (managedEntries.length > maxScanEntries) throw new Error("已有技能超过扫描上限，未导入。");
		const existing = await discoverExternalSkills({
			home: state.home,
			roots: [
				{ label: "managed", path: targetRoot },
				...managedEntries
					.filter(entry => entry.isSymbolicLink())
					.map(entry => ({ label: "managed-link", path: path.join(targetRoot, entry.name) })),
			],
			signal,
		});
		if (existing.truncated) throw new Error("已有技能扫描达到上限，无法可靠检查同名冲突；未导入。");
		const names = new Set([
			...state.resources.entries.filter(item => item.kind === "skill").map(item => item.name!.toLowerCase()),
			...existing.candidates.map(item => item.name.toLowerCase()),
		]);
		const results: ExternalSkillResult[] = [];
		const created: string[] = [];
		const stage = await fs.mkdtemp(path.join(targetRoot, ".import-"));
		try {
			for (const candidate of selected) {
				signal?.throwIfAborted();
				const result: ExternalSkillResult = {
					id: candidate.id,
					name: candidate.name,
					path: path.join(targetRoot, candidate.directoryName),
					status: "failed",
					message: "",
				};
				results.push(result);
				try {
					try {
						await fs.lstat(result.path);
						result.status = "skipped";
						result.message = "目标目录已存在，保留原内容。";
						continue;
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
					const canonical = await fs.realpath(candidate.directory);
					if (canonical !== candidate.directory || !inside(candidate.root, canonical))
						throw new Error("扫描后来源路径已变化，请重新扫描。");
					const info = await metadata(canonical);
					if (info.name !== candidate.name) throw new Error("扫描后技能名称已变化，请重新扫描。");
					if (names.has(info.name.toLowerCase())) {
						result.status = "skipped";
						result.message = "已存在同名技能，保留原内容。";
						continue;
					}
					const entries = await inventory(canonical, signal);
					const staged = path.join(stage, String(results.length));
					await fs.mkdir(staged);
					if (mode === "copy") await copyTree(canonical, staged, entries, signal);
					signal?.throwIfAborted();
					if (mode === "link")
						await fs.symlink(canonical, result.path, process.platform === "win32" ? "junction" : "dir");
					else {
						await fs.mkdir(result.path); // Exclusive directory reservation; never rename over an existing directory.
						created.push(result.path);
						await copyTree(staged, result.path, entries, signal);
					}
					if (mode === "link") created.push(result.path);
					names.add(info.name.toLowerCase());
					result.status = "imported";
					result.message = mode === "copy" ? "已复制并启用。" : "已链接并启用；来源改动会影响此技能。";
				} catch (error) {
					signal?.throwIfAborted();
					result.message = errorMessage(error);
					if (created.includes(result.path)) {
						await fs.rm(result.path, { recursive: true, force: true });
						created.splice(created.indexOf(result.path), 1);
					}
				}
			}
			const imported = results.filter(item => item.status === "imported");
			if (imported.length) {
				const next = structuredClone(state.config);
				for (const item of imported) {
					next.resources.skills.push(path.join(item.path, "SKILL.md"));
					next.resources.disabled = next.resources.disabled?.filter(id => id !== `skill:${item.name}`);
				}
				await apply(next, signal);
			}
			return { results };
		} catch (error) {
			for (const directory of created) await fs.rm(directory, { recursive: true, force: true });
			signal?.throwIfAborted();
			for (const result of results)
				if (result.status === "imported") {
					result.status = "failed";
					result.message = `启用失败，已撤销本次导入：${errorMessage(error)}`;
				}
			return { results };
		} finally {
			await fs.rm(stage, { recursive: true, force: true });
		}
	});
}
