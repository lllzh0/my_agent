import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fixture } from "./helpers";
import { loadResources } from "../src/runtime/resources";

test("disabled skills still reject ambiguous duplicate names instead of sharing one switch", async () => {
	const f = await fixture();
	try {
		for (const directory of ["first", "second"]) {
			const skill = path.join(f.root, directory);
			await Bun.write(path.join(skill, "SKILL.md"), "---\nname: duplicate\ndescription: selected skill\n---\nbody");
			f.config.resources.skills.push(skill);
		}
		f.config.resources.disabled = ["skill:duplicate"];
		await expect(loadResources(f.config, f.cwd, false)).rejects.toThrow("技能名称重复");
	} finally {
		await f.close();
	}
});

test("the main menu applies a resource toggle locally without its own command admission blocking it", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "resources", command: "menu" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult).toBe(2);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].tools?.some(tool => tool.function.name === "write")).toBe(false);
	} finally {
		await f.close();
	}
}, 30000);

test("a disabled tool disappears from requests and a fabricated call cannot execute it", async () => {
	const f = await fixture();
	try {
		f.callTool("write", { path: "disabled.txt", content: "MUST_NOT_WRITE" });
		const run = await f.run({
			action: "commands",
			commands: ["/resources off tool:write", "/resources list"],
			promptAfterCommands: "Try writing the file",
			approve: true,
		});
		expect(run.code, run.stderr).toBe(0);
		expect(f.requests[0].tools?.some(tool => tool.function.name === "write")).toBe(false);
		expect(await Bun.file(path.join(f.cwd, "disabled.txt")).exists()).toBe(false);
		const saved = await Bun.file(path.join(f.home, "config.json")).json();
		expect(saved.resources.disabled).toContain("tool:write");
		Object.assign(f.config, saved);
		const resumed = await f.run({
			resume: run.result.sessionFile,
			action: "commands",
			commands: ["/resources on tool:write"],
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.result.tools).toContain("write");
	} finally {
		await f.close();
	}
}, 30000);

test("live toggles survive stale tool snapshots and new sessions while explicit skills can be re-enabled in-process", async () => {
	const f = await fixture();
	try {
		const file = path.join(f.root, "instruction.md");
		await Bun.write(file, "LIVE_CONTEXT_MARKER");
		const skill = path.join(f.root, "live-skill");
		await Bun.write(path.join(skill, "SKILL.md"), "---\nname: live\ndescription: LIVE_SKILL_MARKER\n---\nbody");
		f.config.resources.instructions = [file];
		f.config.resources.skills = [skill];
		const run = await f.run({ action: "resources", command: "toggle" });
		expect(run.code, run.stderr).toBe(0);
		expect(f.requests).toHaveLength(4);
		for (const [index, enabled] of [true, false, true, true].entries()) {
			const request = f.requests[index];
			const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
			expect(system.includes("LIVE_CONTEXT_MARKER")).toBe(enabled);
			expect(system.includes("LIVE_SKILL_MARKER")).toBe(enabled);
			expect(request.tools?.some(tool => tool.function.name === "read")).toBe(enabled);
		}
		expect(run.result.actionResult).toEqual(["live"]);
	} finally {
		await f.close();
	}
}, 30000);

test("failed resource loading or prompt application preserves the prior runtime and saved configuration", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "resources", command: "rollback" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult.failures).toHaveLength(2);
		expect(run.result.actionResult.sameConfig).toBe(true);
		expect(run.result.actionResult.sameSignature).toBe(true);
		expect(f.requests[0].tools?.some(tool => tool.function.name === "read")).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

test("a resource transition excludes submissions, model/session switches, reviews and competing edits", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "resources", command: "transition" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult).toHaveLength(5);
		expect(run.result.actionResult).not.toContain("admitted");
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].tools?.some(tool => tool.function.name === "read")).toBe(false);
	} finally {
		await f.close();
	}
}, 30000);

test("an active model turn rejects resource mutation without interrupting its existing tools", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "resources", command: "busy" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult).toContain("仍在运行");
		expect(f.requests[0].tools?.some(tool => tool.function.name === "read")).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

test("skill and instruction switches update the next request without restarting or importing ambient files", async () => {
	const f = await fixture();
	try {
		const instruction = path.join(f.root, "chosen instructions.md");
		const extra = path.join(f.root, "extra.md");
		const skill = path.join(f.root, "skill");
		await Bun.write(instruction, "SELECTED_INSTRUCTION_TOKEN");
		await Bun.write(extra, "SELECTED_APPEND_TOKEN");
		await Bun.write(
			path.join(skill, "SKILL.md"),
			"---\nname: selected\ndescription: SELECTED_SKILL_TOKEN\n---\nbody",
		);
		await Bun.write(path.join(f.cwd, "AGENTS.md"), "AMBIENT_MUST_NOT_LOAD");
		f.config.resources.instructions = [instruction];
		f.config.resources.skills = [skill];
		f.config.resources.appendSystem = [extra];
		const run = await f.run({
			action: "commands",
			commands: [
				"/resources off skill:selected",
				`/resources off instruction:${instruction}`,
				`/resources off system:${extra}`,
				"$selected",
			],
			promptAfterCommands: "Continue with resources disabled",
		});
		expect(run.code, run.stderr).toBe(0);
		const system = JSON.stringify(f.requests[0].messages.filter(message => message.role === "system"));
		for (const marker of [
			"SELECTED_INSTRUCTION_TOKEN",
			"SELECTED_APPEND_TOKEN",
			"SELECTED_SKILL_TOKEN",
			"AMBIENT_MUST_NOT_LOAD",
		])
			expect(system).not.toContain(marker);
		expect(run.result.actionResult.at(-1).handled).toBe(true);
		expect(run.result.resources.find((entry: { name?: string }) => entry.name === "selected").loaded).toBe(false);
		Object.assign(f.config, await Bun.file(path.join(f.home, "config.json")).json());
		f.requests.length = 0;
		const restored = await f.run({
			resume: run.result.sessionFile,
			action: "commands",
			commands: [
				"/resources on skill:selected",
				`/resources on instruction:${instruction}`,
				`/resources on system:${extra}`,
			],
			promptAfterCommands: "Continue with resources enabled",
		});
		expect(restored.code, restored.stderr).toBe(0);
		const updated = JSON.stringify(f.requests[0].messages.filter(message => message.role === "system"));
		for (const marker of ["SELECTED_INSTRUCTION_TOKEN", "SELECTED_APPEND_TOKEN", "SELECTED_SKILL_TOKEN"])
			expect(updated).toContain(marker);
		expect(updated).not.toContain("AMBIENT_MUST_NOT_LOAD");
	} finally {
		await f.close();
	}
}, 30000);

test("resource commands from extensions cannot re-enable a human-disabled tool", async () => {
	const f = await fixture();
	try {
		const run = await f.run({
			action: "input",
			inputSource: "extension",
			command: "/resources off tool:read",
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.tools).toContain("read");
		expect(run.result.notifications.some((text: string) => text.includes("用户"))).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

test("hot-added external skills and instructions become readable and reload updates the next request", async () => {
	const f = await fixture();
	try {
		const directory = path.join(f.root, "hot-resources");
		const instruction = path.join(directory, "AGENTS.md");
		const skill = path.join(directory, "skill", "SKILL.md");
		await Bun.write(instruction, "ADDED_INSTRUCTION_MARKER");
		await Bun.write(skill, "---\nname: added\ndescription: ADDED_SKILL_MARKER\n---\nbody");
		const run = await f.run({ action: "resources", command: "reload" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult.names).toEqual(["added"]);
		expect(run.result.actionResult.readable).toBe(await fs.realpath(skill));
		const systems = f.requests.map(request =>
			JSON.stringify(request.messages.filter(message => message.role === "system")),
		);
		expect(systems).toHaveLength(3);
		expect(systems[0]).not.toContain("ADDED_INSTRUCTION_MARKER");
		expect(systems[1]).toContain("ADDED_INSTRUCTION_MARKER");
		expect(systems[1]).toContain("ADDED_SKILL_MARKER");
		expect(systems[2]).toContain("RELOADED_INSTRUCTION_MARKER");
		expect(systems[2]).toContain("RELOADED_SKILL_MARKER");
		expect(systems[2]).not.toContain("ADDED_SKILL_MARKER");
		expect(systems[2]).not.toContain("ADDED_INSTRUCTION_MARKER");
	} finally {
		await f.close();
	}
}, 30000);
