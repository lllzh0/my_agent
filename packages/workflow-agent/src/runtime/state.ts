import type { Config } from "../config/config";
import type { Resources } from "./resources";
import type { Policy } from "../policy/policy";
import type { ChangeJournal } from "../changes/journal";
import type { Workflow } from "../workflow/workflow";
import type { Research } from "../research/research";
import type { Supervisor } from "../processes/supervisor";
import type { Sandbox } from "../processes/sandbox";
import type { ManagedMcp } from "../mcp/manager";
import type { ProductSessions } from "./sessions";

export interface RunState {
	home: string;
	cwd: string;
	stateDir: string;
	sessionId: string;
	light: boolean;
	config: Config;
	resources: Resources;
	policy: Policy;
	journal: ChangeJournal;
	workflow: Workflow;
	research: Research;
	jobs: Supervisor;
	sandbox: Sandbox;
	mcp: ManagedMcp;
	turn: string;
	sessions?: ProductSessions;
}
