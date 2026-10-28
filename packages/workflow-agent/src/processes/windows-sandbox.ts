import { SandboxManager, type SandboxRuntimeConfig } from "@my-agent/windows-sandbox";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { filterManagedSkillRoots } from "../policy/policy";
import type { ExecutionScope } from "./supervisor";
import { commandScript, productShell, type CommandInvocation } from "./shell";
import { windowsSandboxDependencies, windowsSandboxExecutable } from "./sandbox-status";

/** Native Windows isolation; initialization failure never falls back to a host shell. */
export class WindowsSandbox {
	#initialized?: Promise<void>;
	#config?: SandboxRuntimeConfig;
	#closing = false;
	#scratch = "";
	#readSelection = "";
	constructor(
		readonly workspace: string,
		readonly home: string,
		readonly protectedHome: string,
		readonly allowedDomains: string[],
		readonly readRoots: string[],
		readonly writeRoots: string[],
		readonly managedSkillReadRoots: readonly string[],
	) {}

	async #initialize(): Promise<void> {
		const dependencies = await windowsSandboxDependencies();
		if (dependencies.errors.length)
			throw new Error(
				`Windows 沙箱未就绪：${dependencies.errors.join("; ")}；先运行 bun run agent:sandbox install，命令未执行。`,
			);
		const scratch = this.#scratch || (await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-command-")));
		this.#scratch = scratch;
		const managed = filterManagedSkillRoots(this.protectedHome, this.managedSkillReadRoots);
		const readSelection = [this.workspace, scratch, path.dirname(process.execPath), ...this.readRoots, ...managed];
		this.#readSelection = JSON.stringify(readSelection);
		const literal = (value: string) => ({ path: value, literal: true as const });
		const roots = [this.workspace, ...this.readRoots, ...this.writeRoots];
		const denyRead = roots.flatMap(root =>
			[
				"**/.ssh",
				"**/.aws",
				"**/.gnupg",
				"**/.env",
				"**/.env.*",
				"**/env.local",
				"**/*.pem",
				"**/*.key",
				"**/auth.json",
				"**/mcp-auth.json",
			].map(pattern => path.join(root, pattern)),
		);
		const denyWrite = roots.flatMap(root =>
			[
				"**/.agents",
				"**/.codex",
				"**/.pi",
				"**/.omp",
				"**/.env",
				"**/.env.*",
				"**/env.local",
				"**/*.pem",
				"**/*.key",
			].map(pattern => path.join(root, pattern)),
		);
		this.#config = {
			windows: { srtWin: windowsSandboxExecutable },
			network: { allowedDomains: this.allowedDomains, deniedDomains: [], allowLocalBinding: false },
			filesystem: {
				allowRead: readSelection.map(literal),
				allowWrite: [this.workspace, scratch, ...this.writeRoots].map(literal),
				// No profile grant: the dedicated account cannot read the caller's
				// private profile. Stamp denies inside granted roots only; a deny's
				// parent ACE would propagate across unrelated host profile data.
				denyRead: [literal(this.protectedHome), ...denyRead],
				denyWrite: [literal(this.protectedHome), ...denyWrite],
			},
		};
		await SandboxManager.initialize(this.#config, undefined, false);
	}
	async prepare(command: string, signal?: AbortSignal, scope: ExecutionScope = {}): Promise<CommandInvocation> {
		if (this.#closing) throw new Error("Windows 沙箱已关闭");
		signal?.throwIfAborted();
		const initialized = (this.#initialized ??= this.#initialize().catch(error => {
			this.#initialized = undefined;
			throw error;
		}));
		await untilAborted(signal, () => initialized);
		if (this.#closing) throw new Error("Windows 沙箱已关闭");
		signal?.throwIfAborted();
		// Windows grants are fixed at initialize(); a changed read scope requires restart.
		const expected = [
			this.workspace,
			this.#scratch,
			path.dirname(process.execPath),
			...this.readRoots,
			...filterManagedSkillRoots(this.protectedHome, this.managedSkillReadRoots),
		];
		if (JSON.stringify(expected) !== this.#readSelection)
			throw new Error("Windows 沙箱读取范围已改变；请重启会话后执行命令。");
		const prepared = await SandboxManager.wrapWithSandboxArgv(
			commandScript(command),
			productShell(),
			{
				filesystem: {
					denyRead: this.#config!.filesystem.denyRead,
					allowWrite: [],
					denyWrite: [
						...this.#config!.filesystem.denyWrite,
						...(scope.gitWrite
							? []
							: [this.workspace, ...this.writeRoots].map(root => path.join(root, "**", ".git"))),
					],
				},
			},
			signal,
			this.workspace,
		);
		const separator = prepared.argv.indexOf("--");
		if (separator < 0) throw new Error("Windows 沙箱启动参数缺少命令边界；命令未执行");
		const env = {
			...scope.env,
			TMP: this.#scratch,
			TEMP: this.#scratch,
			TMPDIR: this.#scratch,
			npm_config_cache: path.join(this.#scratch, "npm-cache"),
			XDG_CACHE_HOME: path.join(this.#scratch, "cache"),
			PIP_CACHE_DIR: path.join(this.#scratch, "pip-cache"),
		};
		const overlay = Object.entries(env).filter(([key]) => !/^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key));
		const insertion = prepared.argv.indexOf("--env");
		prepared.argv.splice(
			insertion < 0 ? separator : insertion,
			0,
			...overlay.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
		);
		return {
			argv: prepared.argv,
			// srt-win locates its ACL state here. The runner starts with its own
			// account environment and receives only the explicit --env overlay.
			env: { LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local") },
		};
	}
	async close(): Promise<void> {
		this.#closing = true;
		await this.#initialized?.catch(() => undefined);
		await SandboxManager.reset();
		if (this.#scratch) await fs.rm(this.#scratch, { recursive: true, force: true });
	}
}
