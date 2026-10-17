import * as fs from "node:fs/promises";
const { realpath, lstat } = fs;
import * as path from "node:path";
const { resolve, dirname, basename, relative, isAbsolute, join } = path;
import { digest, redact } from "../storage.ts";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { highRiskReason } from "./risk";

export interface Request {
	tool: string;
	kind: "read" | "write" | "execute" | "network" | "external" | "unknown";
	target: string;
	parameters?: Record<string, unknown>;
	review?: ReviewResult;
}
export type ApprovalMode = "manual" | "auto" | "full";
export interface ReviewResult {
	decision: "allow" | "ask" | "deny";
	risk: "low" | "medium" | "high" | "unknown";
	reason: string;
}
export type Reviewer = (request: Request, signal: AbortSignal) => Promise<ReviewResult>;
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
	#approvalMode: ApprovalMode = "manual";
	#revision = 0;
	#reviewer?: Reviewer;
	userTask = "";
	readonly reviewUsage = { requests: 0, tokens: 0, cost: 0 };
	protectedRoots: string[] = [];
	readonly audit: {
		at: string;
		tool: string;
		kind: string;
		target: unknown;
		decision: string;
		mode: ApprovalMode;
		review?: ReviewResult;
	}[] = [];
	constructor(workspace: string, settings: { readRoots: string[]; writeRoots: string[]; allowNetwork: boolean }) {
		this.workspace = resolve(workspace);
		this.settings = settings;
	}
	setApprover(approver: Approver): void {
		this.#approver = approver;
		this.clearGrants();
	}
	get approvalMode(): ApprovalMode {
		return this.#approvalMode;
	}
	get revision(): number {
		return this.#revision;
	}
	setApprovalMode(mode: ApprovalMode): void {
		if (!["manual", "auto", "full"].includes(mode)) throw new Error("未知授权方式");
		this.#approvalMode = mode;
		this.clearGrants();
	}
	setReviewer(reviewer: Reviewer): void {
		this.#reviewer = reviewer;
		this.clearGrants();
	}
	setUserTask(text: string): void {
		this.userTask = text;
		this.clearGrants();
	}
	clearGrants(): void {
		this.#grants.clear();
		this.#revision++;
	}
	assertCurrent(revision: number): void {
		if (revision !== this.#revision) throw new Error("授权状态已变更，旧请求没有执行；请按当前模式重试");
	}
	checkMode(request: Request): void {
		if (this.mode === "plan" && ["write", "execute", "external", "unknown"].includes(request.kind))
			throw new Error("计划模式禁止此类操作；先明确进入执行模式");
		if (request.kind === "network" && !this.settings.allowNetwork && this.#approvalMode !== "full")
			throw new Error("联网读取已禁用");
	}
	async resolvePath(path: string, kind: "read" | "write"): Promise<string> {
		const target = await canonicalPath(resolve(this.workspace, path));
		if (this.#approvalMode === "full") return target;
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
	async authorize(input: Request, signal?: AbortSignal): Promise<void> {
		const request = structuredClone(input);
		delete request.review;
		const revision = this.#revision;
		signal?.throwIfAborted();
		if (request.kind === "read" || request.kind === "write")
			request.target = await this.resolvePath(request.target, request.kind);
		this.checkMode(request);
		const key = digest(JSON.stringify(request));
		let decision: Approval | "allow" = "allow";
		let review: ReviewResult | undefined;
		if (this.#approvalMode !== "full" && !this.#grants.has(key)) {
			if (this.#approvalMode === "auto" && request.kind !== "read") {
				const floor = highRiskReason(request);
				if (floor) review = { decision: "ask", risk: "high", reason: floor };
				else if (
					request.kind === "write" &&
					["write", "edit", "write_report", "file-restore"].includes(request.tool)
				)
					review = { decision: "allow", risk: "low", reason: "已选择范围内的直接文本修改，可通过文件记录检查" };
				else {
					const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
					try {
						if (!this.#reviewer) throw new Error("审核器不可用");
						review = await untilAborted(deadline, () => this.#reviewer!(request, deadline));
						if (
							!review ||
							!["allow", "ask", "deny"].includes(review.decision) ||
							!["low", "medium", "high", "unknown"].includes(review.risk) ||
							typeof review.reason !== "string"
						)
							throw new Error("审核结果无效");
					} catch {
						signal?.throwIfAborted();
						review = {
							decision: "ask",
							risk: "unknown",
							reason: "自动审核未完成或返回无效结果，请人工核对本次操作",
						};
					}
				}
				this.checkMode(request);
				this.assertCurrent(revision);
				if (review.decision === "deny") decision = "deny";
				else if (review.decision !== "allow" || review.risk === "high" || review.risk === "unknown")
					decision = await untilAborted(signal, () => this.#approver({ ...request, review }));
			} else if (this.#approvalMode === "manual" && !["read", "network"].includes(request.kind))
				decision = await untilAborted(signal, () => this.#approver(request));
		}
		signal?.throwIfAborted();
		this.checkMode(request);
		this.assertCurrent(revision);
		this.audit.push({
			at: new Date().toISOString(),
			tool: request.tool,
			kind: request.kind,
			target: redact(request.target),
			decision,
			mode: this.#approvalMode,
			...(review ? { review: redact(review) as ReviewResult } : {}),
		});
		if (this.audit.length > 200) this.audit.shift();
		if (decision === "deny") throw new Error("操作被拒绝；未获得本次请求的授权");
		if (decision === "session") this.#grants.add(key);
	}
}
