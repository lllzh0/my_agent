import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { openHost } from "../src/runtime/host";
import { productCommandCatalog } from "../src/tui/commands";

const options = JSON.parse(process.argv[2]) as { home: string; cwd: string; resultFile: string };
try {
	const host = await openHost({ ...options, interactive: true });
	await initTheme();
	const mode = new InteractiveMode(host.session, "skill integration", undefined, host.setToolUIContext);
	const notifications: string[] = [];
	const ui: ExtensionUIContext = Object.create(host.session.extensionRunner!.getUIContext());
	ui.notify = message => notifications.push(message);
	ui.editor = async () => undefined;
	mode.initializeHookRunner(ui, true);
	mode.setSlashCommandCatalog(productCommandCatalog(host.state));
	new InputController(mode).setupEditorSubmitHandler();
	await host.session.extensionRunner!.emit({ type: "session_start" });
	const submit = async (text: string) => {
		mode.editor.setText(text);
		await mode.editor.onSubmit!(text);
	};
	try {
		await submit("$brainstorming FIRST_SKILL_ARGS");
		await host.state.liveResources!.setEnabled("skill:brainstorming", false);
		await submit("$brainstorming DISABLED_MUST_NOT_SEND");
		await host.state.liveResources!.setEnabled("skill:brainstorming", true);
		await submit("$brainstorming SECOND_SKILL_ARGS");
		await submit("$missing UNKNOWN_MUST_NOT_SEND");
		await submit("/skill:brainstorming LEGACY_MUST_NOT_SEND");
		await Bun.write(
			options.resultFile,
			JSON.stringify({ messages: host.session.messages, notifications, userTask: host.state.policy.userTask }),
		);
	} finally {
		mode.stop();
		await host.dispose();
	}
	process.exit(0);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
}
