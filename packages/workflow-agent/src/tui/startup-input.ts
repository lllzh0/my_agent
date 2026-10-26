import type { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

/** Keep startup keys out of the editor until hooks and the product input loop are ready. */
export async function initializeProductInput(
	mode: InteractiveMode,
	initialize: () => Promise<void>,
	closed: Promise<void>,
): Promise<void> {
	let discarded = false;
	const removeGate = mode.ui.addInputListener(() => {
		discarded = true;
		return { consume: true };
	});
	let idleTimer: NodeJS.Timeout | undefined;
	let deadline: NodeJS.Timeout | undefined;
	const settled = Promise.withResolvers<void>();
	let waiting = false;
	const activity = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => settled.resolve(), 50);
	};
	try {
		await initialize();
		// A painted editor does not mean the OS has delivered its cooked-mode
		// backlog yet. Drain until input has been quiet for one parser interval.
		waiting = true;
		void closed.then(() => {
			if (waiting) settled.reject(new Error("会话已关闭。"));
		});
		process.stdin.on("data", activity);
		activity();
		deadline = setTimeout(() => settled.reject(new Error("启动输入持续未停止，请停止粘贴后重新启动。")), 2000);
		await settled.promise;
		// Incomplete escape/paste sequences otherwise flush on a later timer,
		// after the gate opens, and contaminate the first actual prompt.
		mode.ui.terminal.discardPendingInput?.();
	} finally {
		waiting = false;
		if (idleTimer) clearTimeout(idleTimer);
		if (deadline) clearTimeout(deadline);
		process.stdin.removeListener("data", activity);
		removeGate();
	}
	mode.showStatus(
		discarded ? "输入已就绪；已忽略启动期间的按键，请重新输入。 / 命令 · $ 技能" : "输入已就绪 · / 命令 · $ 技能",
	);
}
