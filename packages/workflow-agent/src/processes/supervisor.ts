import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
const { join } = path;
import * as fs from "node:fs/promises";
const { mkdir } = fs;
import { atomicJson, readJson, redact } from "../storage.ts";
import { Policy } from "../policy/policy.ts";
import { executionEnvironment } from "./environment";

export interface ExecutionBackend {
	wrap(command: string, signal?: AbortSignal): Promise<string>;
	close(): Promise<void>;
}
export interface Job {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	status: "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
	exitCode?: number | null;
	startedAt: string;
	endedAt?: string;
	log: string;
	dropped: number;
}
interface Running {
	child: ChildProcess;
	finished: Promise<void>;
	finish: () => void;
	timer?: NodeJS.Timeout;
	drainTimer?: NodeJS.Timeout;
}
export class Supervisor {
	readonly home: string;
	readonly cwd: string;
	readonly policy: Policy;
	readonly backend: ExecutionBackend;
	#jobs: Job[] = [];
	#running = new Map<string, Running>();
	#starting = 0;
	#closed = false;
	constructor(home: string, cwd: string, policy: Policy, backend: ExecutionBackend) {
		this.home = home;
		this.cwd = cwd;
		this.policy = policy;
		this.backend = backend;
	}
	async load(): Promise<void> {
		const value = await readJson(join(this.home, "jobs.json"));
		if (Array.isArray(value))
			this.#jobs = (value as Job[]).map(job =>
				job.status === "running" ? { ...job, status: "interrupted", pid: undefined } : job,
			);
	}
	list(): Job[] {
		return this.#jobs.map(({ log: _log, ...job }) => ({ ...job, log: "" }));
	}
	get hasActiveJobs(): boolean {
		return this.#starting > 0 || this.#running.size > 0;
	}
	async #persist(): Promise<void> {
		await atomicJson(join(this.home, "jobs.json"), this.#jobs);
	}
	#signalGroup(active: Running, signal: NodeJS.Signals): void {
		try {
			if (active.child.pid) process.kill(-active.child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	output(id: string, cursor = 0): { text: string; cursor: number; status: Job["status"]; truncated: boolean } {
		const job = this.#jobs.find(job => job.id === id);
		if (!job) throw new Error("后台任务不存在");
		const start = Math.max(0, cursor - job.dropped);
		return {
			text: job.log.slice(start),
			cursor: job.dropped + job.log.length,
			status: job.status,
			truncated: cursor < job.dropped,
		};
	}
	async start(command: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Job> {
		if (this.#closed) throw new Error("命令管理器已关闭");
		if (!command.trim() || command.length > 16_000) throw new Error("命令为空或过长");
		if (this.#running.size + this.#starting >= 4) throw new Error("同时最多运行 4 个后台任务");
		this.#starting++;
		try {
			return await this.#start(command, options);
		} finally {
			this.#starting--;
		}
	}
	async #start(command: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<Job> {
		await this.policy.authorize({
			tool: "bash",
			kind: "execute",
			target: command,
			parameters: { timeoutMs: options.timeoutMs ?? 120_000 },
		});
		if (options.signal?.aborted) throw new Error("命令启动已取消");
		const scratch = join(this.home, "scratch");
		await mkdir(scratch, { recursive: true });
		if (this.#closed) throw new Error("命令管理器已关闭");
		const wrapped = await this.backend.wrap(command, options.signal);
		if (this.#closed) {
			// Preparation may have allocated backend resources after close() ran.
			await this.backend.close();
			throw new Error("命令管理器已关闭");
		}
		if (options.signal?.aborted) throw new Error("命令启动已取消");
		const env = executionEnvironment(this.home);
		this.policy.checkMode({ tool: "bash", kind: "execute", target: command });
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", wrapped], {
			cwd: this.cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const job: Job = {
			id: randomUUID(),
			command: String(redact(command)),
			cwd: this.cwd,
			pid: child.pid,
			status: "running",
			startedAt: new Date().toISOString(),
			log: "",
			dropped: 0,
		};
		const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
		const running: Running = { child, finished, finish };
		this.#jobs.push(job);
		this.#running.set(job.id, running);
		const append = (bytes: Buffer) => {
			job.log += String(redact(bytes.toString("utf8")));
			if (job.log.length > 256_000) {
				const excess = job.log.length - 256_000;
				job.log = job.log.slice(excess);
				job.dropped += excess;
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", error => {
			append(Buffer.from(error.message));
			job.status = "failed";
		});
		const complete = (code: number | null) => {
			if (!this.#running.has(job.id)) return;
			if (running.timer) clearTimeout(running.timer);
			if (running.drainTimer) clearTimeout(running.drainTimer);
			options.signal?.removeEventListener("abort", abort);
			job.exitCode = code;
			if (job.status === "running") job.status = code === 0 ? "succeeded" : "failed";
			job.endedAt = new Date().toISOString();
			this.#running.delete(job.id);
			void this.#persist()
				.catch(() => undefined)
				.finally(finish);
		};
		child.once("exit", () => {
			// A completed shell no longer owns a running job. Stop its descendants
			// before stdio closes and the active process group leaves our registry.
			try {
				this.#signalGroup(running, "SIGKILL");
			} catch (error) {
				job.status = "failed";
				append(Buffer.from(`后台子进程清理失败：${error instanceof Error ? error.message : String(error)}`));
			}
			// A descendant can leave our process group while retaining the pipes.
			// Bound waiting for those pipes; their owner is outside our group.
			running.drainTimer = setTimeout(() => {
				if (job.status === "running") job.status = "failed";
				append(Buffer.from("命令输出管道未关闭，已停止等待；主动脱离进程组的程序需另行检查。"));
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
				complete(child.exitCode);
			}, 1000);
		});
		child.on("close", complete);
		const abort = () => {
			void this.stop(job.id).catch(() => undefined);
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		running.timer = setTimeout(
			() => {
				void this.stop(job.id, "timed_out").catch(() => undefined);
			},
			Math.min(Math.max(options.timeoutMs ?? 120_000, 10), 1_200_000),
		);
		if (options.signal?.aborted) abort();
		await this.#persist();
		return { ...job };
	}
	async wait(id: string): Promise<Job> {
		await this.#running.get(id)?.finished;
		const job = this.#jobs.find(job => job.id === id);
		if (!job) throw new Error("后台任务不存在");
		return { ...job };
	}
	async stop(id: string, reason: "cancelled" | "timed_out" = "cancelled"): Promise<void> {
		const job = this.#jobs.find(job => job.id === id);
		const active = this.#running.get(id);
		if (!job || !active) return;
		job.status = reason;
		this.#signalGroup(active, "SIGTERM");
		const force = setTimeout(() => this.#signalGroup(active, "SIGKILL"), 500);
		await active.finished;
		clearTimeout(force);
		// A shell can exit before a child. Kill any remaining member of the original process group.
		this.#signalGroup(active, "SIGKILL");
	}
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all([...this.#running.keys()].map(id => this.stop(id)));
		await this.backend.close();
	}
}
