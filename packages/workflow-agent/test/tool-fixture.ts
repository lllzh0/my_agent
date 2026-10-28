import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { defaultConfig } from "../src/config/config";
import { Policy, type Request } from "../src/policy/policy";
import { openSessionRuntime, closeSessionRuntime } from "../src/runtime/session-state";
import { productTools } from "../src/runtime/tools";
import type { RunState } from "../src/runtime/state";

export async function toolFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-approval-"));
	const cwd = path.join(root, "workspace");
	const home = path.join(root, "home");
	await fs.mkdir(cwd);
	const config = defaultConfig();
	const policy = new Policy(cwd, config.permissions);
	policy.protectedRoots = [home];
	const requests: Request[] = [];
	policy.setApprover(async request => {
		requests.push(request);
		return "once";
	});
	const runtime = await openSessionRuntime(home, cwd, "preview", config, false, policy);
	const settings = await Settings.init({
		cwd,
		agentDir: path.join(home, "agent"),
		inMemory: true,
		discoverProjectSettings: false,
	});
	const state: RunState = {
		...runtime,
		home,
		cwd,
		config,
		policy,
		light: false,
		turn: "preview",
		resources: { entries: [], instructions: [], skills: [], systemPrompt: "", signature: "test" },
	};
	const tools = productTools(state, {
		cwd,
		settings,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	});
	return {
		cwd,
		state,
		tools,
		policy,
		requests,
		runtime,
		run: (name: string, input: unknown) =>
			tools.find(tool => tool.name === name)!.execute("test", input, undefined, undefined, {} as ExtensionContext),
		close: async () => {
			await closeSessionRuntime(runtime);
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
