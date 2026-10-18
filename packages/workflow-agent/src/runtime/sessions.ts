import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	listSessionsReadOnly,
	readSessionInfo,
	type SessionInfo,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { contained } from "../policy/policy";
import { atomicJson, readJson, record } from "../storage";
import { loadResources } from "./resources";
import type { RunState } from "./state";
import { closeSessionRuntime, openSessionRuntime, sessionStateDirectory, type SessionRuntime } from "./session-state";

export type ResumeUI = (sessionFile: string) => Promise<void>;
export interface ResumeResult {
	refreshFailed: boolean;
}

export class ProductSessions {
	#state: RunState;
	#session: AgentSession;
	#activate: (runtime: SessionRuntime) => Promise<void>;
	#ui?: ResumeUI;
	#target?: string;
	#targetSignal?: AbortSignal;
	#closed = false;
	#pending?: Promise<ResumeResult>;
	busy = false;
	constructor(state: RunState, session: AgentSession, activate: (runtime: SessionRuntime) => Promise<void>) {
		this.#state = state;
		this.#session = session;
		this.#activate = activate;
	}
	setUI(ui: ResumeUI | undefined): void {
		this.#ui = ui;
	}
	get closed(): boolean {
		return this.#closed;
	}
	assertSubmissionAllowed(): void {
		if (this.#state.review?.busy) throw new Error("正在审查代码，请先取消或等待完成。");
		if (this.#state.models?.busy) throw new Error("正在切换模型，请稍后再恢复会话。");
		if (this.#closed) throw new Error("会话正在关闭，无法接收新输入。");
		if (this.busy) throw new Error("正在切换会话，请稍后再输入。");
	}
	async close(): Promise<void> {
		this.#closed = true;
		// The caller of resume reports its failure. Teardown still has to close
		// whichever runtime was finally activated, including after a UI error.
		await this.#pending?.catch(() => {});
	}
	permitsNativeSwitch(target: string | undefined): boolean {
		return !!target && target === this.#target && !this.#targetSignal?.aborted;
	}
	#assertIdle(): void {
		if (
			this.#session.hasAdmittedSubmission ||
			this.#session.isStreaming ||
			this.#session.isCompacting ||
			this.#session.isRetrying ||
			this.#session.hasPostPromptWork ||
			this.#session.queuedMessageCount ||
			this.#session.isSessionTransitioning ||
			this.#session.hasActiveEphemeralTurns ||
			this.#session.hasPendingAsyncWork()
		)
			throw new Error("会话仍在运行或有排队消息；先停止后再恢复旧会话。");
		if (this.#state.jobs.hasActiveJobs) throw new Error("后台任务仍在运行或等待批准；先停止任务再恢复旧会话。");
		const goal = this.#session.getGoalModeState();
		if (goal?.enabled || goal?.mode === "exiting")
			throw new Error("目标仍在执行；先用 /goal pause 暂停后再切换会话。");
	}
	async #manifest(info: SessionInfo): Promise<Record<string, unknown>> {
		const manifest = record(
			await readJson(path.join(sessionStateDirectory(this.#state.home, info.id), "manifest.json")),
			"会话记录",
		);
		if (
			manifest.sessionId !== info.id ||
			manifest.cwd !== this.#state.cwd ||
			(await fs.realpath(info.cwd)) !== this.#state.cwd
		)
			throw new Error("只能恢复当前工作区内的产品会话");
		return manifest;
	}
	async list(): Promise<SessionInfo[]> {
		const state = this.#state;
		const sessionDir = await fs.realpath(path.join(state.home, "sessions"));
		const sessions = await listSessionsReadOnly(sessionDir, new FileSessionStorage());
		const selected = await Promise.all(
			sessions.map(async info => {
				try {
					if (info.id === state.sessionId || !contained(sessionDir, await fs.realpath(info.path))) return;
					await this.#manifest(info);
					return info;
				} catch {
					return;
				}
			}),
		);
		return selected.filter((info): info is SessionInfo => info !== undefined);
	}
	async resume(sessionFile: string, signal?: AbortSignal): Promise<ResumeResult> {
		this.assertSubmissionAllowed();
		this.#assertIdle();
		this.busy = true;
		this.#pending = this.#resume(sessionFile, signal);
		return this.#pending;
	}
	async startNew(signal?: AbortSignal): Promise<ResumeResult> {
		this.assertSubmissionAllowed();
		this.#assertIdle();
		this.busy = true;
		this.#pending = this.#startNew(signal);
		return this.#pending;
	}
	async #startNew(signal?: AbortSignal): Promise<ResumeResult> {
		const state = this.#state;
		let prepared: SessionManager | undefined;
		let target: string | undefined;
		let directory: string | undefined;
		let id: string | undefined;
		let releaseTarget: (() => void) | undefined;
		try {
			signal?.throwIfAborted();
			await this.#session.flushToDisk();
			signal?.throwIfAborted();
			this.#assertIdle();
			prepared = SessionManager.create(state.cwd, path.join(state.home, "sessions"));
			prepared.requireExclusiveWriter();
			await prepared.ensureOnDisk();
			id = prepared.getSessionId();
			target = prepared.getSessionFile();
			if (!target || id === state.sessionId) throw new Error("新会话准备失败，原会话已保留。");
			releaseTarget = new FileSessionStorage().claimSession(id, target) ?? undefined;
			if (!releaseTarget) throw new Error("新会话独占写入失败。");
			directory = sessionStateDirectory(state.home, id);
			await atomicJson(path.join(directory, "manifest.json"), {
				signature: state.resources.signature,
				cwd: state.cwd,
				sessionId: id,
				resources: state.resources.entries,
				tools: this.#session.getActiveToolNames(),
			});
			return await this.#resume(target, signal, true);
		} finally {
			try {
				await prepared?.close();
				// Only the UUID minted by this operation is eligible for cleanup.
				// A committed native target remains valid even when UI refresh failed.
				if (id && this.#session.sessionManager.getSessionId() !== id) {
					if (target) await fs.rm(target, { force: true });
					if (directory) await fs.rm(directory, { force: true, recursive: true });
				}
			} finally {
				releaseTarget?.();
				this.busy = false;
				this.#pending = undefined;
			}
		}
	}
	async #resume(sessionFile: string, signal?: AbortSignal, fresh = false): Promise<ResumeResult> {
		const state = this.#state;
		const previousMode = state.policy.mode;
		let staged: SessionRuntime | undefined;
		let releaseSource: (() => void) | undefined;
		let releaseTarget: (() => void) | undefined;
		try {
			signal?.throwIfAborted();
			const sessionDir = await fs.realpath(path.join(state.home, "sessions"));
			const target = await fs.realpath(sessionFile);
			if (!contained(sessionDir, target) || path.extname(target) !== ".jsonl")
				throw new Error("只能恢复当前产品配置目录内的会话");
			const info = await readSessionInfo(target);
			if (!info || info.id === state.sessionId) throw new Error("会话不存在、格式无效或已经打开。");
			const manifest = await this.#manifest(info);
			const resources = fresh ? state.resources : await loadResources(state.config, state.cwd, state.light);
			if (manifest.signature !== state.resources.signature || resources.signature !== state.resources.signature)
				throw new Error("恢复配置与旧会话不一致；请使用原配置或新开会话。");
			const storage = new FileSessionStorage();
			// OMP's leases are refcounted within one process. Hold both identities
			// across the native transaction so neither can be taken during rollback.
			releaseSource = storage.claimSession(state.sessionId, this.#session.sessionFile!) ?? undefined;
			if (!releaseSource) throw new Error("当前会话的独占写入已失效，未切换。");
			releaseTarget = storage.claimSession(info.id, target) ?? undefined;
			if (!releaseTarget) throw new Error("会话正被另一个进程占用；先退出该会话再恢复。");
			staged = await openSessionRuntime(state.home, state.cwd, info.id, state.config, state.light, state.policy);
			signal?.throwIfAborted();
			this.#assertIdle();
			await Promise.all(state.mcp.status().map(server => state.mcp.disconnect(server.name)));
			signal?.throwIfAborted();
			this.#assertIdle();
			await atomicJson(path.join(state.stateDir, "audit.json"), state.policy.audit);
			state.policy.clearGrants();
			state.policy.mode = "plan";
			signal?.throwIfAborted();
			this.#target = target;
			this.#targetSignal = signal;
			let refreshFailed = false;
			try {
				if (this.#ui) await this.#ui(target);
				else await this.#session.switchSession(target, { keepModel: true });
			} catch (error) {
				if (this.#session.sessionFile !== target) throw error;
				// Native history has committed. Finish rebinding the product records
				// even when the UI failed afterwards; closing them would split state.
				refreshFailed = true;
				logger.warn("Resumed session UI refresh failed", { error: String(error) });
			}
			if (this.#session.sessionFile !== target) throw new Error("会话未切换，当前会话已保留。");
			this.#session.sessionManager.requireExclusiveWriter();
			state.policy.setApprovalMode(state.config.permissions.approval ?? "manual");
			state.policy.setUserTask("");
			state.policy.audit.length = 0;
			Object.assign(state.policy.reviewUsage, { requests: 0, tokens: 0, cost: 0 });
			staged.sandbox.fullAccess = false;
			await this.#activate(staged);
			staged = undefined;
			return { refreshFailed };
		} finally {
			this.#target = undefined;
			this.#targetSignal = undefined;
			state.policy.mode = previousMode;
			try {
				if (staged) await closeSessionRuntime(staged);
			} finally {
				try {
					this.#session.sessionManager.requireExclusiveWriter();
				} finally {
					releaseSource?.();
					releaseTarget?.();
					if (!fresh) {
						this.busy = false;
						this.#pending = undefined;
					}
				}
			}
		}
	}
}
