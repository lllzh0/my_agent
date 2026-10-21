import type { Host } from "../src/runtime/host";
import type { Config } from "../src/config/config";
import * as path from "node:path";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/sdk";

export async function resourceScenario(host: Host, scenario: string): Promise<unknown> {
	const { state, session } = host;
	const live = state.liveResources!;
	if (scenario === "menu") {
		const ui: ExtensionUIContext = Object.create(session.extensionRunner!.getUIContext());
		let menuVisits = 0;
		ui.select = async title => {
			if (title === "My Agent") return "修改资源选择";
			if (title.startsWith("资源开关")) return menuVisits++ ? "返回" : "工具";
			return "开 · write";
		};
		await initializeExtensions(session, {
			uiContext: ui,
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		const input = await session.extensionRunner!.emitInput("/agent", undefined, "interactive");
		// Mirror native editor dispatch: an unhandled registered command goes
		// through prompt(), which holds an admitted-submission reservation.
		if (!input.handled) await session.prompt("/agent");
		await session.prompt("AFTER_MENU");
		return menuVisits;
	}
	if (scenario === "toggle") {
		const ids = live
			.list()
			.filter(item => item.kind !== "tool")
			.map(item => item.id);
		await session.prompt("BEFORE_SWITCH");
		for (const id of [...ids, "tool:read"]) await live.setEnabled(id, false);
		// Native goal/restore machinery may restore an older tool snapshot.
		await session.setActiveToolsByName([...session.getEnabledToolNames(), "read"]);
		await session.prompt("AFTER_OFF");
		for (const id of [...ids, "tool:read"]) await live.setEnabled(id, true);
		await session.prompt("AFTER_ON");
		await state.sessions!.startNew();
		await session.prompt("AFTER_NEW");
		return session.skills.map(skill => skill.name);
	}
	if (scenario === "reload") {
		const directory = path.join(state.cwd, "..", "hot-resources");
		const instruction = path.join(directory, "AGENTS.md");
		const skill = path.join(directory, "skill", "SKILL.md");
		await session.prompt("BEFORE_ADDING");
		const next = structuredClone(state.config);
		next.resources.instructions.push(instruction);
		next.resources.skills.push(skill);
		await live.apply(next);
		const readable = await state.policy.resolvePath(skill, "read");
		await session.prompt("AFTER_ADDING");
		await Bun.write(instruction, "RELOADED_INSTRUCTION_MARKER");
		await Bun.write(skill, "---\nname: added\ndescription: RELOADED_SKILL_MARKER\n---\nbody");
		await session.extensionRunner!.emitInput("/resources reload", undefined, "interactive");
		await session.prompt("AFTER_RELOADING");
		return { readable, names: session.skills.map(skill => skill.name) };
	}
	if (scenario === "rollback") {
		const signature = state.resources.signature;
		const original = session.setSkills.bind(session);
		const previous = await Bun.file(path.join(state.home, "config.json")).text();
		let fail = true;
		session.setSkills = async skills => {
			await original(skills);
			if (fail) {
				fail = false;
				throw new Error("fixture prompt refresh failure");
			}
		};
		const failures: string[] = [];
		try {
			await live.setEnabled("tool:read", false);
		} catch (error) {
			failures.push(String(error));
		} finally {
			session.setSkills = original;
		}
		const next: Config = structuredClone(state.config);
		next.resources.instructions.push(path.join(state.cwd, "missing-instruction.md"));
		try {
			await live.apply(next);
		} catch (error) {
			failures.push(String(error));
		}
		const sameConfig = (await Bun.file(path.join(state.home, "config.json")).text()) === previous;
		await session.prompt("AFTER_ROLLBACK");
		return { failures, sameConfig, sameSignature: state.resources.signature === signature };
	}
	if (scenario === "transition") {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = session.setSkills.bind(session);
		session.setSkills = async skills => {
			entered.resolve();
			await release.promise;
			await original(skills);
		};
		const update = live.setEnabled("tool:read", false);
		await entered.promise;
		const blocked: string[] = [];
		try {
			for (const action of [
				() => session.prompt("MUST_NOT_SUBMIT"),
				() => state.sessions!.startNew(),
				() => state.models!.select(state.models!.current().key),
				() => state.review!.run(),
				() => live.setEnabled("tool:write", false),
			]) {
				try {
					await action();
					blocked.push("admitted");
				} catch (error) {
					blocked.push(String(error));
				}
			}
		} finally {
			release.resolve();
			await update;
			session.setSkills = original;
		}
		await session.prompt("AFTER_TRANSITION");
		return blocked;
	}
	if (scenario === "busy") {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const dispose = session.agent.addBeforeModelCallHook(async () => {
			started.resolve();
			await release.promise;
		});
		const turn = session.prompt("BUSY");
		await started.promise;
		let error: string | undefined;
		try {
			await live.setEnabled("tool:read", false);
		} catch (caught) {
			error = String(caught);
		} finally {
			release.resolve();
			await turn;
			dispose();
		}
		return error;
	}
	throw new Error(`Unknown resource test scenario: ${scenario}`);
}
