import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildSkillPromptMessage,
	type BuiltSkillPromptMessage,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { Config } from "../config/config";
import { filterManagedSkillRoots } from "../policy/policy";
import { loadResources } from "../runtime/resources";
import type { RunState } from "../runtime/state";
import type { TemporaryAccess } from "../runtime/temporary-access";
import { digest } from "../storage";

export interface SkillCandidate {
	name: string;
	path: string;
	description: string;
	baseDir: string;
	hash: string;
	enabled: boolean;
	temporary: boolean;
	hidden?: boolean;
	error?: string;
}

interface RegisteredSkill {
	candidate: SkillCandidate;
	skill?: Skill;
}

interface SkillSnapshot {
	skill: Skill;
	hash: string;
	fingerprint: string;
	signal?: AbortSignal;
}

/** Registered skills only; grants never change the human's resource selection. */
export class TemporarySkills {
	#state: RunState;
	#baseConfig: Config;
	#access: TemporaryAccess;
	#candidates: RegisteredSkill[] = [];
	#run = new Map<string, SkillSnapshot>();
	#once = new Map<string, SkillSnapshot>();
	#ownedReadRoots = new Set<string>();
	#ownedManagedRoots = new Set<string>();
	#closed = false;
	#invalidated = new AbortController();
	#unsubscribe: () => void;

	constructor(state: RunState, baseConfig: Config, access: TemporaryAccess) {
		this.#state = state;
		this.#baseConfig = baseConfig;
		this.#access = access;
		this.#unsubscribe = access.subscribe(() => this.syncReadRoots());
	}

	async initialize(): Promise<void> {
		this.#invalidate();
		this.#once.clear();
		this.#candidates = [];
		if (this.#closed || this.#state.light) {
			this.syncReadRoots();
			return;
		}
		const seen = new Set<string>();
		for (const input of new Set([...this.#baseConfig.resources.skills, ...this.#state.config.resources.skills])) {
			try {
				const resources = await this.#load(input);
				for (const skill of resources.skills) {
					const file = await fs.realpath(skill.filePath);
					if (seen.has(file)) continue;
					seen.add(file);
					this.#candidates.push({
						skill: { ...skill, filePath: file, baseDir: path.dirname(file) },
						candidate: {
							name: skill.name,
							path: file,
							baseDir: path.dirname(file),
							description: skill.description,
							hash: resources.entries.find(entry => entry.path === skill.filePath)?.hash ?? "",
							enabled: false,
							temporary: false,
							hidden: skill.hide === true,
						},
					});
				}
			} catch (error) {
				const file = path.resolve(this.#state.cwd, input);
				if (seen.has(file)) continue;
				seen.add(file);
				this.#candidates.push({
					candidate: {
						name: path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file),
						path: file,
						baseDir: path.basename(file) === "SKILL.md" ? path.dirname(file) : file,
						description: "",
						hash: "",
						enabled: false,
						temporary: false,
						error: error instanceof Error ? error.message : String(error),
					},
				});
			}
		}
		for (const entry of this.#candidates)
			if (
				this.#ambiguous(entry.candidate.name) &&
				this.#baseline(entry.candidate.name)?.filePath !== entry.candidate.path
			)
				entry.candidate.error = "技能同名但路径不同，无法确定要加载哪一份。";
		this.syncReadRoots();
	}

	list(): SkillCandidate[] {
		if (this.#closed || this.#state.light) return [];
		return this.#candidates.map(({ candidate }) => ({
			...candidate,
			enabled: !candidate.error && this.#baseline(candidate.name)?.filePath === candidate.path,
			temporary: this.#currentRun(candidate.name)?.skill.filePath === candidate.path,
			...(this.#ambiguous(candidate.name) && this.#baseline(candidate.name)?.filePath !== candidate.path
				? { error: "技能同名但路径不同，无法确定要加载哪一份。" }
				: {}),
		}));
	}

	effectiveSkills(): Skill[] {
		if (this.#closed || this.#state.light) return [];
		const skills = new Map<string, Skill>();
		for (const skill of this.#state.resources.skills) skills.set(skill.name, { ...skill });
		for (const snapshot of this.#activeSnapshots())
			if (!skills.has(snapshot.skill.name)) skills.set(snapshot.skill.name, { ...snapshot.skill });
		return [...skills.values()];
	}

	async prepare(name: string, args: string, reason: string, signal?: AbortSignal): Promise<Skill> {
		this.#assertAvailable();
		if (typeof args !== "string" || typeof reason !== "string") throw new Error("技能申请需要文本参数和理由。");
		signal?.throwIfAborted();
		const baseline = this.#baseline(name);
		if (baseline) return { ...baseline };
		const entry = this.#candidate(name);
		const operationSignal = AbortSignal.any([
			this.#invalidated.signal,
			this.#access.signal,
			...(signal ? [signal] : []),
		]);
		const revision = this.#access.revision;
		const policyRevision = this.#state.policy.revision;
		const assertCurrent = () => {
			operationSignal.throwIfAborted();
			this.#assertAvailable();
			this.#candidate(name);
			if (revision !== this.#access.revision) throw new Error("技能授权已变更，请重新申请。");
			this.#state.policy.assertCurrent(policyRevision);
		};
		assertCurrent();
		const snapshot = await this.#snapshot(entry);
		assertCurrent();
		if (this.#run.get(name)?.fingerprint !== snapshot.fingerprint) this.#run.delete(name);
		this.syncReadRoots();
		const decision = await this.#access.request(
			{
				kind: "skill",
				key: name,
				fingerprint: snapshot.fingerprint,
				label: name,
				reason,
				details: {
					name,
					path: snapshot.skill.filePath,
					hash: snapshot.hash,
					description: snapshot.skill.description,
					args,
					readRoot: snapshot.skill.baseDir,
					readOnly: true,
					notice:
						"只允许读取此技能包；其它工具、执行、联网和写入仍按原权限检查。已载入聊天的正文无法通过撤销删除。",
				},
			},
			operationSignal,
		);
		try {
			assertCurrent();
			if (decision !== "once" && decision !== "run" && decision !== "enabled")
				throw new Error("技能申请被拒绝；未获得临时加载权限。");
			const current = await this.#snapshot(entry);
			assertCurrent();
			if (current.fingerprint !== snapshot.fingerprint) throw new Error("技能正文或路径已变化，请重新申请。");
			if (decision !== "once" && !this.#access.has("skill", name, snapshot.fingerprint))
				throw new Error("技能授权已失效，请重新申请。");
			if (decision === "once") this.#once.set(name, { ...snapshot, signal: this.#access.signal });
			else this.#run.set(name, snapshot);
			this.syncReadRoots();
			return { ...snapshot.skill };
		} catch (error) {
			if (decision === "run" && this.#access.has("skill", name, snapshot.fingerprint))
				this.#access.revoke("skill", name);
			this.#once.delete(name);
			this.#run.delete(name);
			this.syncReadRoots();
			throw error;
		}
	}

	async load(name: string, args: string, reason: string, signal?: AbortSignal): Promise<BuiltSkillPromptMessage> {
		return buildSkillPromptMessage(await this.prepare(name, args, reason, signal), { args });
	}

	finishTurn(): void {
		this.#invalidate();
		this.#once.clear();
		this.syncReadRoots();
	}

	revoke(name?: string): void {
		this.#invalidate();
		this.#access.revoke("skill", name);
		if (name === undefined) {
			this.#run.clear();
			this.#once.clear();
		} else {
			this.#run.delete(name);
			this.#once.delete(name);
		}
		this.syncReadRoots();
	}

	async grant(name: string, signal?: AbortSignal): Promise<void> {
		this.#assertAvailable();
		signal?.throwIfAborted();
		if (this.#baseline(name)) return;
		const operationSignal = AbortSignal.any([
			this.#invalidated.signal,
			this.#access.signal,
			...(signal ? [signal] : []),
		]);
		const policyRevision = this.#state.policy.revision;
		const snapshot = await this.#snapshot(this.#candidate(name));
		operationSignal.throwIfAborted();
		this.#state.policy.assertCurrent(policyRevision);
		this.#access.grant("skill", name, snapshot.fingerprint);
		this.#run.set(name, snapshot);
		this.syncReadRoots();
	}

	/** Reapply only owned package reads after the host replaces its baseline roots. */
	syncReadRoots(): void {
		const state = this.#state;
		const baseline = new Set([
			...state.config.permissions.readRoots,
			...state.config.resources.instructions.map(file => path.resolve(state.cwd, file)),
			...state.config.resources.skills.map(file => path.resolve(state.cwd, file)),
			...state.resources.skills.map(skill => skill.baseDir),
		]);
		const baselineManaged = new Set(
			filterManagedSkillRoots(
				state.home,
				state.resources.skills.map(skill => skill.baseDir),
			),
		);
		const roots = new Set(this.#activeSnapshots().map(snapshot => snapshot.skill.baseDir));
		this.#syncRoots(state.policy.settings.readRoots, this.#ownedReadRoots, roots, baseline);
		this.#syncRoots(
			state.policy.managedSkillReadRoots,
			this.#ownedManagedRoots,
			new Set(filterManagedSkillRoots(state.home, [...roots])),
			baselineManaged,
		);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.revoke();
		this.#unsubscribe();
	}

	async #load(file: string) {
		const config: Config = {
			...this.#baseConfig,
			resources: { instructions: [], skills: [file], extensions: [], appendSystem: [] },
		};
		return loadResources(config, this.#state.cwd, false);
	}

	async #snapshot(entry: RegisteredSkill): Promise<SkillSnapshot> {
		try {
			const file = await fs.realpath(entry.candidate.path);
			if (file !== entry.candidate.path) throw new Error("技能路径已变化，请重新加载候选。");
			const resources = await this.#load(file);
			const skill = resources.skills[0];
			if (!skill || skill.name !== entry.candidate.name) throw new Error("技能名称或内容已变化，请重新加载候选。");
			const content = await Bun.file(file).slice(0, 1_000_001).text();
			if (Buffer.byteLength(content) > 1_000_000) throw new Error("SKILL.md 超过 1MB 上限。");
			const hash = digest(content);
			if (hash !== resources.entries.find(item => item.kind === "skill")?.hash)
				throw new Error("读取时技能正文已变化，请重新申请。");
			entry.candidate.hash = hash;
			entry.candidate.description = skill.description;
			entry.candidate.hidden = skill.hide === true;
			return {
				skill: { ...skill, filePath: file, baseDir: path.dirname(file), content },
				hash,
				fingerprint: digest(`${file}\n${hash}`),
			};
		} catch (error) {
			this.#run.delete(entry.candidate.name);
			this.#once.delete(entry.candidate.name);
			this.syncReadRoots();
			throw error;
		}
	}

	#candidate(name: string): RegisteredSkill {
		this.#assertAvailable();
		const entry = this.#candidates.find(item => item.candidate.name === name);
		if (this.#ambiguous(name)) throw new Error(`技能同名但路径不同：${name}；请先消除歧义。`);
		if (!entry || entry.candidate.error || !entry.skill)
			throw new Error(
				`当前运行不能申请此技能：${name}${entry?.candidate.error ? `；${entry.candidate.error}` : ""}`,
			);
		return entry;
	}

	#baseline(name: string): Skill | undefined {
		return this.#state.resources.skills.find(skill => skill.name === name);
	}

	#ambiguous(name: string): boolean {
		return (
			new Set([
				...this.#candidates.filter(item => item.candidate.name === name).map(item => item.candidate.path),
				...this.#state.resources.skills.filter(skill => skill.name === name).map(skill => skill.filePath),
			]).size > 1
		);
	}

	#currentRun(name: string): SkillSnapshot | undefined {
		const snapshot = this.#run.get(name);
		if (!snapshot || !this.#access.has("skill", name, snapshot.fingerprint)) return undefined;
		const candidate = this.#candidates.find(item => item.candidate.name === name)?.candidate;
		return candidate && !candidate.error && candidate.hash === snapshot.hash && !this.#ambiguous(name)
			? snapshot
			: undefined;
	}

	#activeSnapshots(): SkillSnapshot[] {
		if (this.#closed || this.#state.light) return [];
		const snapshots: SkillSnapshot[] = [];
		for (const name of this.#run.keys()) {
			const snapshot = this.#currentRun(name);
			if (snapshot) snapshots.push(snapshot);
		}
		for (const snapshot of this.#once.values())
			if (!snapshot.signal?.aborted && !this.#ambiguous(snapshot.skill.name)) snapshots.push(snapshot);
		return snapshots;
	}

	#syncRoots(target: string[], owned: Set<string>, desired: Set<string>, baseline: Set<string>): void {
		for (const root of owned) {
			if (desired.has(root)) continue;
			if (!baseline.has(root)) {
				const index = target.indexOf(root);
				if (index !== -1) target.splice(index, 1);
			}
			owned.delete(root);
		}
		for (const root of desired) {
			if (target.includes(root)) continue;
			target.push(root);
			owned.add(root);
		}
	}

	#assertAvailable(): void {
		if (this.#closed || this.#state.light) throw new Error("当前运行不能申请临时技能。");
	}

	#invalidate(): void {
		this.#invalidated.abort(new Error("技能授权或当前轮次已变更，请重新申请。"));
		this.#invalidated = new AbortController();
	}
}
