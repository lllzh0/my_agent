import { afterEach, expect, test, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.resetForTests();
});

for (const reportFails of [false, true])
	test(`a ${reportFails ? "failed" : "successful"} budget report restores mounted tools without granting filesystem writes`, async () => {
		using temp = TempDir.createSync("pi-report-tools-");
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "isolated-test-key");
		const settings = Settings.isolated({ "task.softRequestBudget": 2 });
		const registry = new ModelRegistry(auth, temp.join("models.yml"));
		const created = await sdk.createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			settings,
			sessionManager: SessionManager.inMemory(temp.path()),
			bindProcessState: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			toolNames: ["read", "grep", "glob"],
			extensions: [
				api =>
					api.registerTool({
						name: "test_mounted_tool",
						label: "Mounted Test",
						description: "Local test device",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "done" }] };
						},
					}),
			],
		});
		const { session } = created;
		try {
			const enabled = session.getEnabledToolNames();
			const mounted = session.getMountedXdevToolNames();
			expect(mounted).toContain("test_mounted_tool");
			const write = session.getToolByName("write")!;
			await expect(
				write.execute("before", { path: temp.join("before.txt"), content: "must be refused" }),
			).rejects.toThrow("Filesystem writes are not available");
			const mock = createMockModel({
				handler: context => {
					if (!context.tools?.length)
						return reportFails
							? { stopReason: "error", errorMessage: "isolated final report failure" }
							: { content: ["Partial findings; remaining paths unexamined."] };
					return { content: [{ type: "toolCall", name: "read", arguments: { path: temp.join("missing.txt") } }] };
				},
			});
			vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
			vi.spyOn(sdk, "createAgentSession").mockResolvedValue(created);
			AgentRegistry.global().register({
				id: "report-tools",
				displayName: "report-tools",
				kind: "sub",
				session,
				sessionFile: null,
				status: "running",
			});
			const result = await runSubprocess({
				cwd: temp.path(),
				agent: { name: "scout", description: "test", systemPrompt: "test", source: "project" },
				task: "Inspect remaining paths",
				index: 0,
				id: "report-tools",
				settings,
				modelRegistry: registry,
				enableLsp: false,
				artifactsDir: temp.path(),
				structured: false,
			});
			expect(result.exitCode).toBe(reportFails ? 1 : 0);
			expect(mock.calls.some(call => !call.context.tools?.length)).toBe(true);
			await expect(
				session
					.getToolByName("write")!
					.execute("after", { path: temp.join("after.txt"), content: "must still be refused" }),
			).rejects.toThrow("Filesystem writes are not available");
			expect(await Bun.file(temp.join("after.txt")).exists()).toBe(false);
			expect(session.getMountedXdevToolNames()).toEqual(mounted);
			expect(session.getEnabledToolNames()).toEqual(enabled);
		} finally {
			await session.dispose();
			auth.close();
		}
	}, 30000);
