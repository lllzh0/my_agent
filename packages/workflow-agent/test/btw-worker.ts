import * as path from "node:path";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { BtwHistoryStore, type BtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { openHost } from "../src/runtime/host";
import { productCommandCatalog } from "../src/tui/commands";

const options = JSON.parse(process.argv[2]) as {
	home: string;
	cwd: string;
	resultFile: string;
	action: "ask" | "cancel" | "history" | "tool-call" | "branch";
	resume?: string;
};

async function waitFor(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await Bun.sleep(10);
	}
}

try {
	const approval = Promise.withResolvers<"once">();
	const approvalStarted = Promise.withResolvers<void>();
	const host = await openHost({
		...options,
		interactive: true,
		approve: async () => {
			approvalStarted.resolve();
			return approval.promise;
		},
	});
	await initTheme();
	const mode = new InteractiveMode(host.session, "BTW integration", undefined, host.setToolUIContext);
	const notifications: string[] = [];
	const ui: ExtensionUIContext = Object.create(host.session.extensionRunner!.getUIContext());
	ui.notify = message => notifications.push(message);
	ui.editor = async () => undefined;
	// Use the real InteractiveMode extension initialization and submit path;
	// the terminal renderer stays stopped in this subprocess fixture.
	mode.initializeHookRunner(ui, true);
	mode.setSlashCommandCatalog(productCommandCatalog(host.state));
	new InputController(mode).setupEditorSubmitHandler();
	await host.session.extensionRunner!.emit({ type: "session_start" });
	const submit = async (text: string) => {
		mode.editor.setText(text);
		await mode.editor.onSubmit!(text);
	};
	const records = async () => {
		const store = await BtwHistoryStore.open(host.session.sessionManager.getArtifactsDir() ?? undefined);
		return store.getRecords();
	};
	try {
		if (options.action === "history") {
			await submit("/btw");
			await Bun.write(
				options.resultFile,
				JSON.stringify({
					records: await records(),
					overlay: mode.ui.hasOverlay(),
					messages: host.session.messages,
				}),
			);
		} else {
			const objective =
				options.action === "cancel"
					? "MAIN_OBJECTIVE write the requested main file"
					: "MAIN_OBJECTIVE main transcript context";
			host.state.policy.setUserTask(objective);
			let main: Promise<boolean> | undefined;
			if (options.action === "cancel") {
				main = host.session.prompt(objective);
				await approvalStarted.promise;
			} else await host.session.prompt(objective);
			const goal = await host.session.goalRuntime.createGoal({ objective: "MAIN_GOAL_OBJECTIVE" });
			host.session.setGoalModeState(goal);
			const before = structuredClone(host.session.messages);
			const question =
				options.action === "cancel"
					? "STALL_CHILD side question"
					: options.action === "tool-call"
						? "SIDE_TOOL_ATTEMPT"
						: "Explain SIDE_QUESTION";
			await submit(`/btw ${question}`);
			let saved: readonly BtwHistoryRecord[] = [];
			if (options.action === "cancel") {
				await waitFor(() => Bun.file(path.join(options.home, "child-request-received")).exists(), "side request");
				mode.handleBtwEscape();
			}
			await waitFor(async () => {
				saved = await records();
				return saved.length === 1 && saved[0].status === (options.action === "cancel" ? "cancelled" : "complete");
			}, "durable side history");
			const sideState = {
				before,
				after: structuredClone(host.session.messages),
				mainStreaming: host.session.isStreaming,
				userTask: host.state.policy.userTask,
				goal: host.session.getGoalModeState()?.goal.objective,
			};
			let branch: { ready: boolean; sessionUnchanged: boolean } | undefined;
			if (options.action === "branch") {
				const sessionFile = host.session.sessionFile;
				const ready = mode.canBranchBtw();
				await mode.handleBtwBranchKey();
				branch = { ready, sessionUnchanged: host.session.sessionFile === sessionFile };
			}
			// Stop goal continuation before releasing the deliberately paused main turn.
			host.session.setGoalModeState(undefined);
			approval.resolve("once");
			await main;
			await submit("/btw");
			await Bun.write(
				options.resultFile,
				JSON.stringify({
					...sideState,
					branch,
					records: saved,
					overlay: mode.ui.hasOverlay(),
					messages: host.session.messages,
					sessionFile: host.session.sessionFile,
					notifications,
				}),
			);
		}
	} finally {
		approval.resolve("once");
		mode.stop();
		await host.dispose();
	}
	process.exit(0);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
}
