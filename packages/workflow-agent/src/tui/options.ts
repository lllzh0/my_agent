import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { quote } from "shell-quote";

export function productKeybindings(): KeybindingsManager {
	return KeybindingsManager.inMemory({
		"app.model.cycleForward": [],
		"app.model.cycleBackward": [],
		"app.model.select": [],
		"app.model.selectTemporary": [],
		"app.editor.external": [],
		"app.agents.hub": [],
		"app.session.new": [],
		"app.session.tree": [],
		"app.session.fork": [],
		"app.session.resume": [],
		"app.session.observe": [],
		"app.plan.toggle": [],
		"app.stt.pushToTalk": [],
		"app.stt.toggle": [],
		"app.live.toggle": [],
	});
}

export function productResumeCommand(
	home: string,
	cwd: string,
	sessionFile: string,
	demo: boolean,
	light: boolean,
): string {
	return quote([
		"bun",
		path.resolve(import.meta.dir, "../launcher.ts"),
		"--home",
		home,
		"--cwd",
		cwd,
		...(demo ? ["--demo"] : []),
		...(light ? ["--light"] : []),
		"--resume",
		sessionFile,
	]);
}
