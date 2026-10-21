import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { saveConfig, validateConfig, type Config } from "../config/config";
import { atomicJson, readJson } from "../storage";
import { loadResources, resourceDisabled } from "./resources";
import type { RunState } from "./state";

export interface ResourceSwitch {
	id: string;
	kind: string;
	name: string;
	enabled: boolean;
	active: boolean;
}

/** Human-owned selection, applied only while all consumers are idle. */
export class LiveResources {
	#state: RunState;
	#session: AgentSession;
	#toolNames: readonly string[];
	#pending?: Promise<void>;
	#closed = false;
	#blocked = false;
	get busy(): boolean {
		return this.#pending !== undefined;
	}
	constructor(state: RunState, session: AgentSession, toolNames: readonly string[]) {
		this.#state = state;
		this.#session = session;
		this.#toolNames = [...toolNames];
	}
	assertSubmissionAllowed(): void {
		if (this.#closed || this.#blocked) throw new Error("资源切换已关闭或回退失败，请退出后重新打开会话。");
		if (this.busy) throw new Error("正在切换资源，请稍后再输入。");
	}
	async close(): Promise<void> {
		this.#closed = true;
		await this.#pending?.catch(() => {});
	}
	list(): ResourceSwitch[] {
		const state = this.#state;
		const active = new Set(this.#session.getEnabledToolNames());
		return [
			...this.#toolNames.map(name => ({
				id: `tool:${name}`,
				kind: "tool",
				name,
				enabled: !resourceDisabled(state.config, `tool:${name}`),
				active: active.has(name),
			})),
			...state.resources.entries
				.filter(entry => entry.kind !== "extension")
				.map(entry => ({
					id: `${entry.kind}:${entry.kind === "skill" ? entry.name : entry.path}`,
					kind: entry.kind,
					name: entry.kind === "skill" ? entry.name! : entry.path,
					enabled: entry.selected,
					active: entry.loaded,
				})),
		];
	}
	#assertIdle(): void {
		const state = this.#state;
		const session = this.#session;
		if (state.light) throw new Error("轻量模式没有工作流资源和工具；请正常启动后使用资源开关。");
		if (state.sessions?.closed || state.sessions?.busy || state.models?.busy || state.review?.busy)
			throw new Error("会话正在关闭、切换或审查，请等待完成。");
		if (
			session.hasAdmittedSubmission ||
			session.isStreaming ||
			session.isRetrying ||
			session.isCompacting ||
			session.hasPostPromptWork ||
			session.queuedMessageCount ||
			session.isSessionTransitioning ||
			session.hasActiveEphemeralTurns ||
			session.hasPendingAsyncWork() ||
			state.jobs.hasActiveJobs
		)
			throw new Error("会话、旁问或后台任务仍在运行；请先停止或等待完成，再切换资源。");
		const goal = session.getGoalModeState();
		if (goal?.enabled || goal?.mode === "exiting") throw new Error("请先 /goal pause 暂停目标，再切换资源。");
	}
	/** Reapply the selection after native goal/session tool snapshots are restored. */
	async syncTools(): Promise<void> {
		const session = this.#session;
		const state = this.#state;
		const current = session.getEnabledToolNames();
		const next = this.#toolNames.filter(name => {
			if (resourceDisabled(state.config, `tool:${name}`)) return false;
			// Goal owns activation of its lifecycle tool.
			return name !== "goal" || current.includes("goal");
		});
		if (current.length !== next.length || current.some(name => !next.includes(name)))
			await session.setActiveToolsByName(next);
	}
	setEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
		if (!this.list().some(item => item.id === id))
			throw new Error(`资源不存在：${id}；使用 /resources list 查看 ID。`);
		const next = structuredClone(this.#state.config);
		const disabled = new Set(next.resources.disabled ?? []);
		if (enabled) disabled.delete(id);
		else disabled.add(id);
		if (disabled.size) next.resources.disabled = [...disabled];
		else delete next.resources.disabled;
		return this.apply(next, signal);
	}
	apply(next: Config, signal?: AbortSignal): Promise<void> {
		this.assertSubmissionAllowed();
		this.#assertIdle();
		const operation = this.#apply(validateConfig(structuredClone(next)), signal);
		this.#pending = operation;
		return operation.finally(() => {
			this.#pending = undefined;
		});
	}
	async #apply(next: Config, signal?: AbortSignal): Promise<void> {
		const state = this.#state;
		const session = this.#session;
		const previousConfig = state.config;
		const previousResources = state.resources;
		const previousTools = session.getEnabledToolNames();
		const configPath = path.join(state.home, "config.json");
		const manifestPath = path.join(state.stateDir, "manifest.json");
		signal?.throwIfAborted();
		const resources = await loadResources(next, state.cwd, state.light);
		// Read all rollback data before changing runtime or disk.
		const previousDiskConfig = await readJson(configPath);
		const previousManifest = await readJson(manifestPath);
		this.#assertIdle();
		if (this.#closed) throw new Error("会话正在关闭，资源未切换。");
		signal?.throwIfAborted();
		let configAttempted = false;
		let manifestAttempted = false;
		state.config = next;
		state.resources = resources;
		try {
			await session.setSkills(resources.skills);
			await this.syncTools();
			signal?.throwIfAborted();
			if (this.#closed) throw new Error("会话正在关闭，资源切换已取消。");
			configAttempted = true;
			await saveConfig(state.home, next);
			manifestAttempted = true;
			await atomicJson(manifestPath, {
				signature: resources.signature,
				cwd: state.cwd,
				sessionId: state.sessionId,
				resources: resources.entries,
				tools: session.getEnabledToolNames(),
			});
			state.policy.settings.readRoots.splice(
				0,
				state.policy.settings.readRoots.length,
				...next.permissions.readRoots,
				...next.resources.instructions.map(file => path.resolve(state.cwd, file)),
				...next.resources.skills.map(file => path.resolve(state.cwd, file)),
			);
			state.policy.clearGrants();
		} catch (error) {
			state.config = previousConfig;
			state.resources = previousResources;
			try {
				await session.setSkills(previousResources.skills);
				await session.setActiveToolsByName(previousTools);
				if (configAttempted) {
					if (previousDiskConfig === undefined) await fs.rm(configPath, { force: true });
					else await atomicJson(configPath, previousDiskConfig);
				}
				if (manifestAttempted) {
					if (previousManifest === undefined) await fs.rm(manifestPath, { force: true });
					else await atomicJson(manifestPath, previousManifest);
				}
			} catch (rollbackError) {
				this.#blocked = true;
				throw new Error(`资源回退失败，请退出后检查配置：${String(rollbackError)}；原错误：${String(error)}`);
			}
			throw error;
		}
	}
}
