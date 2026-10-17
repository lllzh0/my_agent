import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { type CreateAgentSessionOptions, createAgentSession, type ToolDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("restricted SDK sessions opting into the native goal tool", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("pi-sdk-restricted-goal-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "isolated-test-key");
		settings = Settings.isolated();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	async function makeSession(options: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
		const writeParameters = type({ path: "string", content: "string" });
		const callerWrite: ToolDefinition<typeof writeParameters> = {
			name: "write",
			label: "Caller write",
			description: "Record a caller-controlled write request",
			parameters: writeParameters,
			approval: "write",
			execute: async (_id, params) => {
				await Bun.write(tempDir.join("caller-write.json"), JSON.stringify(params));
				return { content: [{ type: "text", text: "Recorded caller write" }] };
			},
		};
		const { session: created } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			settings,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			bindProcessState: false,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			customTools: [callerWrite],
			toolNames: ["write", "goal"],
			...options,
		});
		session = created;
		return created;
	}

	// The embedding host owns /goal entry and requests the native tool only after
	// its GoalRuntime has created or resumed the goal.
	async function enterGoalMode(s: AgentSession): Promise<void> {
		await s.goalRuntime.createGoal({ objective: "Finish the restricted host task", tokenBudget: 100 });
		await s.setActiveToolsByName(["write", "goal"]);
	}

	it("keeps goal unavailable without explicit admission even when the host requests activation", async () => {
		const s = await makeSession();
		expect(s.getAllToolNames()).toEqual(["write"]);

		await enterGoalMode(s);

		expect(s.getEnabledToolNames()).toEqual(["write"]);
		expect(s.agent.state.tools.map(tool => tool.name)).toEqual(["write"]);
	});

	it("admits native goal operations without replacing the caller write or widening the initial tool set", async () => {
		const s = await makeSession({ allowRestrictedGoalTool: true });
		// An explicit initial toolNames entry still must not advertise goal before /goal.
		expect(s.getEnabledToolNames()).toEqual(["write"]);
		expect(s.agent.state.tools.map(tool => tool.name)).toEqual(["write"]);
		expect(s.getAllToolNames().toSorted()).toEqual(["goal", "write"]);

		await enterGoalMode(s);

		expect(s.agent.state.tools.map(tool => tool.name).toSorted()).toEqual(["goal", "write"]);
		const goalTool = s.agent.state.tools.find(tool => tool.name === "goal")!;
		const fetched = await goalTool.execute("get-goal", { op: "get" });
		expect(fetched.details).toMatchObject({
			op: "get",
			goal: { objective: "Finish the restricted host task", status: "active", tokenBudget: 100 },
			remainingTokens: 100,
		});

		const requestedPath = tempDir.join("must-not-be-written.txt");
		const writeTool = s.agent.state.tools.find(tool => tool.name === "write")!;
		await writeTool.execute("caller-write", { path: requestedPath, content: "through caller" });
		expect(await Bun.file(tempDir.join("caller-write.json")).json()).toEqual({
			path: requestedPath,
			content: "through caller",
		});
		expect(await Bun.file(requestedPath).exists()).toBe(false);

		const completed = await goalTool.execute("complete-goal", { op: "complete" });
		expect(completed.details).toMatchObject({ op: "complete", goal: { status: "complete" } });
		expect(s.getGoalModeState()).toMatchObject({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: { status: "complete" },
		});
		expect(s.getAllToolNames().toSorted()).toEqual(["goal", "write"]);
	});

	it("registers goal lazily after settings enable it and lets the host resume the same goal", async () => {
		cfgGoalEnabled.set(settings, false);
		const s = await makeSession({ allowRestrictedGoalTool: true });
		expect(s.getAllToolNames()).toEqual(["write"]);
		cfgGoalEnabled.set(settings, true);

		await enterGoalMode(s);

		expect(s.getEnabledToolNames().toSorted()).toEqual(["goal", "write"]);
		const goalId = s.getGoalModeState()!.goal.id;
		await s.goalRuntime.pauseGoal();
		await s.setActiveToolsByName(["write"]);
		expect(s.agent.state.tools.map(tool => tool.name)).toEqual(["write"]);
		await s.goalRuntime.resumeGoal();
		await s.setActiveToolsByName(["write", "goal"]);
		const goalTool = s.agent.state.tools.find(tool => tool.name === "goal")!;
		const fetched = await goalTool.execute("get-resumed-goal", { op: "get" });
		expect(fetched.details).toMatchObject({ goal: { id: goalId, status: "active" } });
	});

	it("keeps goal disabled by settings even when a restricted caller opts in and requests activation", async () => {
		cfgGoalEnabled.set(settings, false);
		const s = await makeSession({ allowRestrictedGoalTool: true });

		await enterGoalMode(s);

		expect(s.getAllToolNames()).toEqual(["write"]);
		expect(s.getEnabledToolNames()).toEqual(["write"]);
		expect(s.agent.state.tools.map(tool => tool.name)).toEqual(["write"]);
	});
});
