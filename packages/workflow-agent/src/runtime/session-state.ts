import * as path from "node:path";
import type { Config } from "../config/config";
import type { Policy } from "../policy/policy";
import { Sandbox } from "../processes/sandbox";
import { Supervisor } from "../processes/supervisor";
import { ManagedMcp } from "../mcp/manager";
import { ChangeJournal } from "../changes/journal";
import { Research } from "../research/research";
import { Workflow } from "../workflow/workflow";
import { Diagnostics } from "../diagnostics/errors";

export interface SessionRuntime {
	sessionId: string;
	stateDir: string;
	sandbox: Sandbox;
	jobs: Supervisor;
	mcp: ManagedMcp;
	journal: ChangeJournal;
	research: Research;
	workflow: Workflow;
	diagnostics: Diagnostics;
}

export function sessionStateDirectory(home: string, sessionId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("会话 ID 格式无效");
	return path.join(home, "state", sessionId);
}

export async function closeSessionRuntime(runtime: SessionRuntime): Promise<void> {
	const results = await Promise.allSettled([
		runtime.mcp.close(),
		runtime.jobs.close(),
		runtime.diagnostics.flush(),
		runtime.journal.close(),
		runtime.research.close(),
	]);
	const failed = results.find(result => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
}

export async function openSessionRuntime(
	home: string,
	cwd: string,
	sessionId: string,
	config: Config,
	light: boolean,
	policy: Policy,
): Promise<SessionRuntime> {
	const stateDir = sessionStateDirectory(home, sessionId);
	const sandbox = new Sandbox(
		cwd,
		stateDir,
		config.permissions.allowNetwork ? config.sandbox.allowedDomains : [],
		policy.settings.readRoots,
		home,
		config.permissions.writeRoots,
	);
	sandbox.fullAccess = policy.approvalMode === "full";
	const runtime: SessionRuntime = {
		sessionId,
		stateDir,
		sandbox,
		jobs: new Supervisor(stateDir, cwd, policy, sandbox, config.execution?.envNames),
		mcp: new ManagedMcp(config.mcpServers, policy, sandbox, cwd, stateDir, light),
		journal: new ChangeJournal(stateDir, cwd, async target => {
			await policy.resolvePath(target, "write");
		}),
		research: new Research(stateDir, config.search),
		workflow: new Workflow(path.join(stateDir, "workflow.json")),
		diagnostics: new Diagnostics(stateDir),
	};
	const loaded = await Promise.allSettled([
		runtime.jobs.load(),
		runtime.journal.load(),
		runtime.research.load(),
		runtime.workflow.load(),
		runtime.diagnostics.load(),
	]);
	const failed = loaded.find(result => result.status === "rejected");
	if (failed?.status === "rejected") {
		await closeSessionRuntime(runtime);
		throw failed.reason;
	}
	return runtime;
}
