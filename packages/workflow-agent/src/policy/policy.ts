import * as fs from "node:fs/promises";
const { realpath, lstat } = fs;
import * as path from "node:path";
const { resolve, dirname, basename, relative, isAbsolute, join } = path;
import { digest, redact } from "../storage.ts";

export interface Request {
	tool: string;
	kind: "read" | "write" | "execute" | "network" | "external" | "unknown";
	target: string;
	parameters?: unknown;
}
export type Approval = "once" | "session" | "deny";
export type Approver = (request: Request) => Promise<Approval>;

export async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		try {
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) throw new Error("不允许悬空符号链接");
		} catch (nested) {
			if ((nested as NodeJS.ErrnoException).code !== "ENOENT") throw nested;
		}
		return join(await canonicalPath(parent), basename(path));
	}
}

export function contained(root: string, path: string): boolean {
	const child = relative(root, path);
	return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export class Policy {
	readonly workspace: string;
	readonly settings: { readRoots: string[]; writeRoots: string[]; allowNetwork: boolean };
	mode: "plan" | "execute" = "execute";
	#approver: Approver = async () => "deny";
	#grants = new Set<string>();
	protectedRoots: string[] = [];
	readonly audit: { at: string; tool: string; kind: string; target: unknown; decision: string }[] = [];
	constructor(workspace: string, settings: { readRoots: string[]; writeRoots: string[]; allowNetwork: boolean }) {
		this.workspace = resolve(workspace);
		this.settings = settings;
	}
	setApprover(approver: Approver): void {
		this.#approver = approver;
		this.#grants.clear();
	}
	clearGrants(): void {
		this.#grants.clear();
	}
	checkMode(request: Request): void {
		if (this.mode === "plan" && ["write", "execute", "external", "unknown"].includes(request.kind))
			throw new Error("计划模式禁止此类操作；先明确进入执行模式");
		if (request.kind === "network" && !this.settings.allowNetwork) throw new Error("联网读取已禁用");
	}
	async resolvePath(path: string, kind: "read" | "write"): Promise<string> {
		const target = await canonicalPath(resolve(this.workspace, path));
		for (const root of this.protectedRoots)
			if (contained(await canonicalPath(root), target)) throw new Error("目标属于受保护的应用状态目录");
		const roots = [this.workspace, ...this.settings.readRoots, ...(kind === "write" ? this.settings.writeRoots : [])];
		const allowed = kind === "write" ? [this.workspace, ...this.settings.writeRoots] : roots;
		if (!(await Promise.all(allowed.map(canonicalPath))).some(root => contained(root, target)))
			throw new Error("目标超出工作区或允许范围");
		if (kind === "write" && /(?:^|[/\\])(?:\.git|\.codex|\.agents|\.pi|\.omp)(?:$|[/\\])/i.test(target))
			throw new Error("不能通过文件工具修改受保护的执行配置目录");
		if (
			/(?:^|[/\\])(?:\.ssh|\.aws|\.gnupg|\.env(?:\.[^/\\]+)?|auth\.json|mcp-auth\.json|id_rsa|id_ed25519|[^/\\]+\.(?:pem|key))(?:$|[/\\])/i.test(
				target,
			) &&
			!target.endsWith(".env.example")
		)
			throw new Error("受限凭据文件不能由工具访问");
		return target;
	}
	async authorize(input: Request): Promise<void> {
		const request = { ...input };
		if (request.kind === "read" || request.kind === "write")
			request.target = await this.resolvePath(request.target, request.kind);
		this.checkMode(request);
		const key = digest(JSON.stringify(request));
		let decision: Approval | "allow" = "allow";
		if (!["read", "network"].includes(request.kind) && !this.#grants.has(key))
			decision = await this.#approver(request);
		this.checkMode(request);
		this.audit.push({
			at: new Date().toISOString(),
			tool: request.tool,
			kind: request.kind,
			target: redact(request.target),
			decision,
		});
		if (this.audit.length > 200) this.audit.shift();
		if (decision === "deny") throw new Error("操作被拒绝；未获得本次请求的授权");
		if (decision === "session") this.#grants.add(key);
	}
}
