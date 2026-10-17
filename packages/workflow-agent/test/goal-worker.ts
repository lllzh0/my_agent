import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { openHost } from "../src/runtime/host";
import { productCommandCatalog } from "../src/tui/commands";
import { productKeybindings } from "../src/tui/options";
import { runProductInputLoop } from "../src/tui/input-loop";

const options = JSON.parse(process.argv[2]) as {
	home: string;
	cwd: string;
	resultFile: string;
	scenario:
		| "complete"
		| "continue"
		| "continue-constraints"
		| "resume-constraints"
		| "controls"
		| "restore"
		| "resume-auto"
		| "resume-menu-auto"
		| "shutdown-wait";
	resume?: string;
};
const host = await openHost({ ...options, interactive: true });
const mode = new InteractiveMode(host.session, "goal integration", undefined, host.setToolUIContext);
const notifications: string[] = [];
mode.showStatus = text => {
	notifications.push(text);
};
mode.showWarning = text => {
	notifications.push(text);
};
mode.showError = text => {
	notifications.push(text);
};
let loop: Promise<void> | undefined;
try {
	await mode.init({
		suppressWelcomeIntro: true,
		autoStartCollab: false,
		keybindings: productKeybindings(),
		slashCommandCatalog: productCommandCatalog(host.state),
	});
	const submit = async (text: string) => {
		await mode.editor.onSubmit!(text);
	};
	const initial = { goal: host.session.getGoalModeState(), tools: host.session.getEnabledToolNames() };
	let details: unknown;
	if (options.scenario === "controls") {
		await host.session.prompt("SEED_SESSION");
		await submit("/goal set PRODUCT_GOAL");
		const active = { goal: host.session.getGoalModeState(), tools: host.session.getEnabledToolNames() };
		await submit("/goal budget 5000");
		await submit("/goal budget 12oops");
		await submit("/plan");
		const planWhileActive = host.state.policy.mode;
		await submit("/goal pause");
		const paused = { goal: host.session.getGoalModeState(), tools: host.session.getEnabledToolNames() };
		await submit("/plan");
		await submit("/goal resume");
		const planBlocked = host.session.getGoalModeState();
		await submit("/plan");
		await submit("/goal resume");
		const resumed = { goal: host.session.getGoalModeState(), tools: host.session.getEnabledToolNames() };
		const denied = await host.session.extensionRunner!.emitInput(
			"/goal set MODEL_REPLACEMENT",
			undefined,
			"extension",
		);
		await submit("/goal pause");
		details = { active, paused, resumed, planBlocked, planWhileActive, denied };
	} else if (options.scenario === "shutdown-wait") {
		await submit("/goal set STOP_DURING_GOAL_EXIT");
		await host.session.goalRuntime.completeGoalFromTool();
		const closing = Promise.withResolvers<void>();
		loop = runProductInputLoop(mode, host.session, closing.promise);
		closing.resolve();
		try {
			await untilAborted(AbortSignal.timeout(500), () => loop!);
			details = { inputLoopClosed: true };
		} finally {
			mode.onInputCallback?.({ text: "", cancelled: true, started: false });
		}
	} else if (options.scenario !== "restore") {
		const finished = Promise.withResolvers<void>();
		const firstTurn = Promise.withResolvers<void>();
		const humanTurn = Promise.withResolvers<void>();
		const constraints = options.scenario === "continue-constraints" || options.scenario === "resume-constraints";
		let turns = 0;
		let completed = false;
		const unsubscribe = host.session.subscribe(event => {
			if (event.type === "goal_updated" && event.state?.goal.status === "complete") completed = true;
			if (event.type === "agent_end") {
				turns++;
				if (turns === 1) firstTurn.resolve();
				if (turns === 2) humanTurn.resolve();
				if (completed) finished.resolve();
			}
		});
		loop = runProductInputLoop(mode, host.session, host.closed);
		if (options.scenario === "resume-auto" || options.scenario === "resume-menu-auto") {
			await submit("/permissions auto");
			const continuing = Promise.withResolvers<void>();
			const release = host.session.subscribe(event => {
				if (
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === "goal-continuation"
				)
					continuing.resolve();
			});
			if (options.scenario === "resume-menu-auto") {
				mode.showHookSelector = async () => "Resume";
				await submit("/goal");
			} else await submit("/goal resume");
			await untilAborted(AbortSignal.timeout(5000), () => continuing.promise);
			release();
			// Exercise the real model reviewer without executing an external action.
			// Simple workspace text writes intentionally use the local fast path.
			await host.state.policy.authorize({
				tool: "goal-context-check",
				kind: "external",
				target: "local-fixture-action",
			});
		} else {
			await submit(
				`/goal set ${options.scenario === "continue" || constraints ? "NEED_CONTINUATION" : "COMPLETE_PRODUCT_GOAL"}`,
			);
			if (constraints) {
				await untilAborted(AbortSignal.timeout(5000), () => firstTurn.promise);
				if (options.scenario === "resume-constraints") await submit("/goal pause");
				await submit("STRICT_HUMAN_CONSTRAINT: explain only; do not run external actions.");
				await untilAborted(AbortSignal.timeout(5000), () => humanTurn.promise);
				if (options.scenario === "resume-constraints") await submit("/goal resume");
			}
		}
		await untilAborted(AbortSignal.timeout(5000), () => finished.promise);
		unsubscribe();
		// agent_end precedes the next input wait's asynchronous tool restoration.
		// Wait for retirement itself instead of assuming one timer tick is enough.
		await untilAborted(AbortSignal.timeout(5000), async () => {
			while (host.session.getGoalModeState()?.mode === "exiting") await Bun.sleep(1);
		});
	}
	await Bun.write(
		options.resultFile,
		JSON.stringify({
			initial,
			details,
			notifications,
			goal: host.session.getGoalModeState(),
			tools: host.session.getEnabledToolNames(),
			messages: host.session.messages,
			sessionFile: host.session.sessionFile,
			userTask: host.state.policy.userTask,
			changes: host.state.journal.list(),
			reviewUsage: host.state.policy.reviewUsage,
		}),
	);
} finally {
	mode.stop();
	await host.dispose();
	await loop;
}
