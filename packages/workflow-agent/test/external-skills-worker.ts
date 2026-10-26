import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openHost } from "../src/runtime/host";
import { discoverExternalSkills, importExternalSkills } from "../src/skills/external";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/sdk";

const options = JSON.parse(process.argv[2]) as { root: string; home: string; cwd: string; scenario: string };
const host = await openHost({ home: options.home, cwd: options.cwd, light: options.scenario === "light" });
const { state, session } = host;
try {
	const root = path.join(options.root, "source");
	const discovery = await discoverExternalSkills({ home: options.root, roots: [{ label: "custom", path: root }] });
	const first = discovery.candidates.find(item => item.directoryName === "first")!;
	const second = discovery.candidates.find(item => item.directoryName === "second")!;
	const target = path.join(state.home, "skills/first");
	const before = await Bun.file(path.join(options.home, "config.json")).text();
	if (options.scenario === "copy" || options.scenario === "link") {
		const result = await importExternalSkills(
			state,
			discovery,
			[first.id],
			options.scenario === "link" ? "link" : "copy",
		);
		expect(result.results.map(item => item.status)).toEqual(["imported"]);
		expect(state.config.resources.skills).toEqual([path.join(target, "SKILL.md")]);
		expect(await Bun.file(path.join(target, "references/example.txt")).text()).toBe("SUPPORT_FILE");
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(options.scenario === "link");
		expect(session.skills.map(item => item.name)).toEqual(["first"]);
		const reference = path.join(target, "references/example.txt");
		expect(await state.policy.resolvePath(reference, "read")).toBe(await fs.realpath(reference));
		await expect(state.policy.resolvePath(reference, "write")).rejects.toThrow();
		expect(await Bun.file(path.join(options.home, "skills/second/SKILL.md")).exists()).toBe(false);
		await session.prompt("IMPORTED_SKILL");
		await state.liveResources!.setEnabled("skill:first", false);
		await expect(state.policy.resolvePath(reference, "read")).rejects.toThrow();
		await session.prompt("DISABLED_SKILL");
		expect(session.skills).toEqual([]);
		await state.liveResources!.setEnabled("skill:first", true);
		expect(session.skills.map(item => item.name)).toEqual(["first"]);
	} else if (options.scenario === "conflicts") {
		await fs.mkdir(target, { recursive: true });
		await Bun.write(path.join(target, "keep.txt"), "EXISTING");
		const sameName = discovery.candidates.find(item => item.directoryName === "duplicate")!;
		const existing = path.join(options.root, "existing");
		await Bun.write(path.join(existing, "SKILL.md"), "---\nname: first\ndescription: existing\n---\nbody");
		const next = structuredClone(state.config);
		next.resources.skills.push(path.join(existing, "SKILL.md"));
		await state.liveResources!.apply(next);
		const result = await importExternalSkills(state, discovery, [first.id, sameName.id, second.id]);
		expect(result.results.map(item => item.status)).toEqual(["skipped", "skipped", "imported"]);
		expect(await Bun.file(path.join(target, "keep.txt")).text()).toBe("EXISTING");
		expect(session.skills.map(item => item.name).sort()).toEqual(["first", "second"]);
	} else if (options.scenario === "rollback") {
		// A real resource failure after import staging: saved config still references a now-removed instruction.
		const instruction = path.join(options.root, "instruction.md");
		await Bun.write(instruction, "OLD");
		const next = structuredClone(state.config);
		next.resources.instructions.push(instruction);
		await state.liveResources!.apply(next);
		const previous = await Bun.file(path.join(options.home, "config.json")).text();
		const signature = state.resources.signature;
		await fs.rm(instruction);
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("failed");
		expect(state.resources.signature).toBe(signature);
		expect(await Bun.file(path.join(options.home, "config.json")).text()).toBe(previous);
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "unsafe") {
		await fs.symlink(options.home, path.join(first.directory, "escape"));
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("failed");
		expect(result.results[0].message).toContain("链接");
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(options.home, "config.json")).text()).toBe(before);
	} else if (options.scenario === "cancel") {
		const controller = new AbortController();
		controller.abort();
		await expect(importExternalSkills(state, discovery, [first.id], "copy", controller.signal)).rejects.toThrow();
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(options.home, "config.json")).text()).toBe(before);
	} else if (options.scenario === "busy") {
		const active = session.prompt("BUSY_IMPORT");
		await expect(importExternalSkills(state, discovery, [first.id])).rejects.toThrow();
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
		await active;
	} else if (options.scenario === "unknown") {
		await expect(importExternalSkills(state, discovery, ["../../escape"])).rejects.toThrow();
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "concurrency") {
		const applying = importExternalSkills(state, discovery, [first.id]);
		await expect(importExternalSkills(state, discovery, [second.id])).rejects.toThrow();
		await expect(session.prompt("MUST_NOT_RUN_DURING_IMPORT")).rejects.toThrow();
		await applying;
		expect(await Bun.file(path.join(options.home, "skills/second/SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "target-conflict") {
		await Bun.write(path.join(root, "group/first/SKILL.md"), "---\nname: third\ndescription: third skill\n---\nbody");
		const again = await discoverExternalSkills({ home: options.root, roots: [{ label: "custom", path: root }] });
		const third = again.candidates.find(item => item.name === "third")!;
		const result = await importExternalSkills(state, again, [first.id, third.id]);
		expect(result.results.map(item => item.status)).toEqual(["imported", "skipped"]);
		expect(session.skills.map(item => item.name)).toEqual(["first"]);
	} else if (options.scenario === "managed-link-conflict") {
		await fs.mkdir(path.join(state.home, "skills"));
		await fs.symlink(first.directory, path.join(state.home, "skills/previous-link"));
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("skipped");
		expect(state.config.resources.skills).toEqual([]);
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "managed-conflict") {
		await Bun.write(
			path.join(state.home, "skills/existing/SKILL.md"),
			"---\nname: first\ndescription: managed skill\n---\nbody",
		);
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("skipped");
		expect(state.config.resources.skills).toEqual([]);
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "oversized") {
		const handle = await fs.open(path.join(first.directory, "large.bin"), "w");
		await handle.truncate(50_000_001);
		await handle.close();
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("failed");
		expect(result.results[0].message).toContain("50MB");
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "light") {
		await expect(importExternalSkills(state, discovery, [first.id])).rejects.toThrow("轻量模式");
		await expect(fs.lstat(path.join(state.home, "skills"))).rejects.toThrow();
	} else if (options.scenario === "mid-cancel") {
		for (let index = 0; index < 200; index++)
			await Bun.write(path.join(first.directory, `many/file-${index}.txt`), "CANCEL_SUPPORT");
		const controller = new AbortController();
		const operation = importExternalSkills(state, discovery, [first.id], "copy", controller.signal);
		const settled = operation.then(
			() => "success",
			() => "cancelled",
		);
		for (let index = 0; index < 5000; index++) {
			try {
				await fs.lstat(target);
				controller.abort();
				break;
			} catch {
				await Bun.sleep(1);
			}
		}
		expect(controller.signal.aborted).toBe(true);
		expect(await settled).toBe("cancelled");
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(options.home, "config.json")).text()).toBe(before);
		expect((await fs.readdir(path.dirname(target))).some(name => name.startsWith(".import-"))).toBe(false);
		expect(state.liveResources!.busy).toBe(false);
	} else if (options.scenario === "batch-conflicts") {
		const duplicate = discovery.candidates.find(item => item.directoryName === "duplicate")!;
		const result = await importExternalSkills(state, discovery, [first.id, duplicate.id]);
		expect(result.results.map(item => item.status)).toEqual(["imported", "skipped"]);
		expect(state.config.resources.skills).toEqual([path.join(target, "SKILL.md")]);
	} else if (options.scenario === "safe-links") {
		await fs.symlink("references/example.txt", path.join(first.directory, "safe.txt"));
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("imported");
		expect(await Bun.file(path.join(target, "safe.txt")).text()).toBe("SUPPORT_FILE");
	} else if (options.scenario === "cyclic-links") {
		await fs.mkdir(path.join(first.directory, "a"));
		await fs.mkdir(path.join(first.directory, "b"));
		await fs.symlink("../b", path.join(first.directory, "a/to-b"));
		await fs.symlink("../a", path.join(first.directory, "b/to-a"));
		const result = await importExternalSkills(state, discovery, [first.id]);
		expect(result.results[0].status).toBe("failed");
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (options.scenario === "link-unsafe") {
		await fs.symlink(options.home, path.join(first.directory, "escape"));
		const result = await importExternalSkills(state, discovery, [first.id], "link");
		expect(result.results[0].status).toBe("failed");
		expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false);
	} else if (
		options.scenario === "ui" ||
		options.scenario === "ui-cancel" ||
		options.scenario === "ui-same-directory"
	) {
		const duplicateDirectory = options.scenario === "ui-same-directory";
		if (duplicateDirectory)
			await Bun.write(
				path.join(root, "group/first/SKILL.md"),
				"---\nname: third\ndescription: other skill\n---\nbody",
			);
		const ui: ExtensionUIContext = Object.create(session.extensionRunner!.getUIContext());
		const choices = [
			"导入外部技能",
			"自定义目录",
			"CHOOSE_SKILL",
			"预览并继续",
			"复制（推荐）",
			options.scenario === "ui-cancel" ? "取消导入" : "导入并启用",
			"返回",
		];
		ui.select = async (_title, labels) => {
			const next = choices.shift();
			if (next === "CHOOSE_SKILL") {
				const selected = labels
					.filter((label): label is string => typeof label === "string")
					.find(label => (duplicateDirectory ? label.includes("third") : label.includes("first")));
				expect(selected).toBeDefined();
				return selected;
			}
			expect(labels).toContain(next!);
			return next;
		};
		ui.input = async () => root;
		ui.editor = async () => undefined;
		ui.notify = () => {};
		await initializeExtensions(session, {
			uiContext: ui,
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		await session.extensionRunner!.emitInput("/resources", undefined, "interactive");
		expect(session.skills.map(item => item.name)).toEqual(
			options.scenario === "ui-cancel" ? [] : [duplicateDirectory ? "third" : "first"],
		);
		expect(choices).toEqual([]);
	}
} finally {
	await host.dispose();
}
