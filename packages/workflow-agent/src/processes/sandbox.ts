import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import * as os from "node:os";
const { homedir } = os;
import * as path from "node:path";
const { join } = path;
import * as fs from "node:fs/promises";
const { mkdir, realpath } = fs;
import type { ExecutionBackend, ExecutionScope } from "./supervisor.ts";
import { protectMacOSCommand } from "./seatbelt";

export class Sandbox implements ExecutionBackend {
	readonly workspace: string;
	readonly home: string;
	readonly allowedDomains: string[];
	readonly readRoots: string[];
	readonly protectedHome: string;
	readonly writeRoots: string[];
	fullAccess = false;
	#ready = false;
	#status = "尚未初始化";
	get status(): string {
		return this.fullAccess ? "已关闭（完整授权）" : this.#status;
	}
	#scratch = "";
	constructor(
		workspace: string,
		home: string,
		allowedDomains: string[],
		readRoots: string[] = [],
		protectedHome = home,
		writeRoots: string[] = [],
	) {
		this.workspace = workspace;
		this.home = home;
		this.allowedDomains = allowedDomains;
		this.readRoots = readRoots;
		this.protectedHome = protectedHome;
		this.writeRoots = writeRoots;
	}
	async wrap(command: string, signal?: AbortSignal, scope: ExecutionScope = {}): Promise<string> {
		if (this.fullAccess) return command;
		if (!this.#ready) {
			if (process.platform !== "darwin") throw new Error("首版命令隔离仅支持 macOS；命令没有执行");
			const dependencies = SandboxManager.checkDependencies();
			if (dependencies.errors.length)
				throw new Error(`沙箱依赖缺失：${dependencies.errors.join("; ")}；命令没有执行`);
			const scratchPath = join(this.home, "scratch");
			await mkdir(scratchPath, { recursive: true });
			const scratch = await realpath(scratchPath);
			this.#scratch = scratch;
			const workspace = await realpath(this.workspace);
			try {
				await SandboxManager.initialize(
					{
						network: { allowedDomains: this.allowedDomains, deniedDomains: [] },
						filesystem: {
							denyRead: [
								homedir(),
								await realpath(this.home),
								join(homedir(), ".ssh"),
								join(homedir(), ".aws"),
								join(homedir(), ".gnupg"),
								"**/.env",
								"**/.env.*",
								"**/*.pem",
								"**/*.key",
							],
							allowRead: [
								workspace,
								scratch,
								...(await Promise.all(this.readRoots.map(path => realpath(path)))),
							],
							allowWrite: [
								workspace,
								scratch,
								...(await Promise.all(this.writeRoots.map(path => realpath(path)))),
							],
							denyWrite: [
								join(workspace, ".git"),
								join(workspace, ".agents"),
								join(workspace, ".codex"),
								"**/.env",
								"**/.env.*",
								"**/*.pem",
								"**/*.key",
							],
						},
					},
					undefined,
					false,
				);
				this.#ready = true;
				this.#status = "已启用（macOS）";
			} catch (error) {
				this.#status = "不可用";
				throw new Error(`沙箱初始化失败；拒绝执行：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// Runtime 0.0.50 overrides TMPDIR with /tmp/claude without creating it.
		// Set the owned temporary path inside the sandbox, after its environment setup.
		const temporary = `'${this.#scratch.replace(/'/g, `'\\''`)}'`;
		const gitDirectory = join(await realpath(this.workspace), ".git");
		const wrapped = await SandboxManager.wrapWithSandbox(
			`export TMPDIR=${temporary}; ${command}`,
			"/bin/bash",
			scope.gitWrite
				? {
						filesystem: {
							...SandboxManager.getConfig()!.filesystem,
							denyWrite: SandboxManager.getConfig()!.filesystem.denyWrite.filter(
								value => value !== gitDirectory,
							),
						},
					}
				: undefined,
			signal,
		);
		return protectMacOSCommand(wrapped, await realpath(this.protectedHome), this.#scratch, scope.gitWrite);
	}
	async close(): Promise<void> {
		if (this.#ready) {
			await SandboxManager.reset();
			this.#ready = false;
			this.#status = "已停止";
		}
	}
}
