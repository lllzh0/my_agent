import { expect, test } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { CombinedAutocompleteProvider, Editor } from "@oh-my-pi/pi-tui";
import type { Resources } from "../src/runtime/resources";
import { productCommandCatalog } from "../src/tui/commands";
import { fixture } from "./helpers";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { createSkillAutocompleteProvider } from "../src/tui/skill-input";
import { defaultEditorTheme } from "../../tui/test/test-themes";

test("typing or pasting dollar opens the skill menu and Tab preserves existing arguments", async () => {
	const skill: Skill = {
		name: "brainstorming",
		description: "Plan a feature",
		filePath: "/skills/brainstorming/SKILL.md",
		baseDir: "/skills/brainstorming",
		source: "test",
	};
	for (const paste of [false, true]) {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			createSkillAutocompleteProvider(new CombinedAutocompleteProvider(), () => [skill]),
		);
		if (paste) editor.pasteText("$bra");
		else editor.handleInput("$");
		await Bun.sleep(10);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput("\t");
		expect(editor.getText()).toBe("$brainstorming ");
	}
	const editor = new Editor(defaultEditorTheme);
	editor.setAutocompleteProvider(createSkillAutocompleteProvider(new CombinedAutocompleteProvider(), () => [skill]));
	editor.setText("$bra 保留需求");
	editor.handleInput("\x01");
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[C");
	editor.handleInput("i");
	await Bun.sleep(10);
	expect(editor.isShowingAutocomplete()).toBe(true);
	editor.handleInput("\t");
	expect(editor.getText()).toBe("$brainstorming 保留需求");
});

test("rapid skill typing followed by Tab completes the current token instead of losing the selection", async () => {
	const editor = new Editor(defaultEditorTheme);
	editor.setAutocompleteProvider(
		createSkillAutocompleteProvider(new CombinedAutocompleteProvider(), () => [
			{
				name: "brainstorming",
				description: "Plan a feature",
				filePath: "/skills/brainstorming/SKILL.md",
				baseDir: "/skills/brainstorming",
				source: "test",
			},
		]),
	);
	editor.handleInput("$");
	await Bun.sleep(10);
	for (const key of ["b", "r", "a", "\t"]) editor.handleInput(key);
	await Bun.sleep(10);
	expect(editor.getText()).toBe("$brainstorming ");
});

test("dollar completion follows enabled skills, preserves arguments, and delegates file and command completion", async () => {
	let skills: Skill[] = [
		{
			name: "brainstorming",
			description: "Plan a feature",
			filePath: "/skills/brainstorming/SKILL.md",
			baseDir: "/skills/brainstorming",
			source: "test",
		},
		{
			name: "mcp",
			description: "Skill with a command name",
			filePath: "/skills/mcp/SKILL.md",
			baseDir: "/skills/mcp",
			source: "test",
		},
	];
	const base = new CombinedAutocompleteProvider([{ name: "help" }, { name: "mcp" }]);
	const provider = createSkillAutocompleteProvider(base, () => skills);
	const all = await provider.getSuggestions(["$"], 0, 1);
	expect(all?.items.map(item => item.value)).toEqual(["$brainstorming", "$mcp"]);
	const selected = await provider.getSuggestions(["  $bra 既有需求"], 0, 6);
	expect(selected?.items.map(item => item.value)).toEqual(["$brainstorming"]);
	expect(provider.applyCompletion(["  $brain 既有需求"], 0, 8, selected!.items[0], selected!.prefix)).toMatchObject({
		lines: ["  $brainstorming 既有需求"],
		cursorLine: 0,
		cursorCol: 17,
	});
	const slash = await provider.getSuggestions(["/"], 0, 1);
	expect(slash?.items.map(item => item.value).sort()).toEqual(["help", "mcp"]);
	expect(provider.trySyncSlashCompletion?.("/he")?.items.map(item => item.value)).toEqual(["help"]);
	for (const lines of [["解释 $bra"], ["普通正文", "$bra"], ["$brainstorming 参数"]]) {
		const line = lines.length - 1;
		const suggestions = await provider.getSuggestions(lines, line, lines[line].length);
		expect(suggestions?.items.some(item => item.value === "$brainstorming")).not.toBe(true);
	}
	skills = [];
	expect(await provider.getSuggestions(["$"], 0, 1)).toBeNull();
	expect(provider.shouldTriggerFileCompletion?.(["$missing"], 0, 8)).toBe(false);
	expect(await provider.getForceFileSuggestions?.(["$missing"], 0, 8)).toBeNull();
});

test("slash suggestions exclude selected skills", async () => {
	const resources = {
		skills: [{ name: "brainstorming", description: "Plan a feature" }],
	} as Resources;
	const provider = new CombinedAutocompleteProvider(productCommandCatalog({ resources }));
	const suggestions = await provider.getSuggestions(["/"], 0, 1);
	expect(suggestions?.items.some(item => item.value === "help")).toBe(true);
	expect(suggestions?.items.some(item => item.value.startsWith("skill:"))).toBe(false);
});

test("dollar skill input resolves only active skills and legacy slash skills cannot run", async () => {
	const f = await fixture();
	try {
		const skill = path.join(f.root, "brainstorming/SKILL.md");
		await Bun.write(skill, "---\nname: brainstorming\ndescription: Plan a feature\n---\nBRAINSTORMING_BODY\n");
		f.config.resources.skills = [skill];
		const run = await f.run({
			action: "commands",
			commands: [
				"$brainstorming 小功能需求",
				"/skill:brainstorming",
				"/resources off skill:brainstorming",
				"$brainstorming 不应运行",
				"/resources on skill:brainstorming",
				"$brainstorming 已重新启用",
				"$missing 不应运行",
				"请使用 /skill:brainstorming 旧语法",
			],
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult[0]).toMatchObject({ text: "/skill:brainstorming 小功能需求" });
		expect(run.result.actionResult[1].handled).toBe(true);
		expect(run.result.actionResult[3].handled).toBe(true);
		expect(run.result.actionResult[5]).toMatchObject({ text: "/skill:brainstorming 已重新启用" });
		expect(run.result.actionResult[6].handled).toBe(true);
		expect(run.result.actionResult[7].handled).toBe(true);
		expect(run.result.notifications.some((text: string) => text.includes("$brainstorming"))).toBe(true);
		expect(run.result.notifications.some((text: string) => text.includes("missing"))).toBe(true);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("inline dollar text and shell expressions remain ordinary prompts", async () => {
	const f = await fixture();
	try {
		const commands = ["解释 $HOME 的作用", "请说明 $brainstorming 的用法", "$50 是价格", `\${HOME}/project`];
		const run = await f.run({ action: "commands", commands });
		expect(run.code, run.stderr).toBe(0);
		for (const result of run.result.actionResult) {
			expect(result.handled).not.toBe(true);
			expect(result.text).toBeUndefined();
		}
		expect(run.result.userTask).toBe(`\${HOME}/project`);
	} finally {
		await f.close();
	}
}, 30_000);

test("selected digit-leading skill names work without treating currency as a missing skill", async () => {
	const f = await fixture();
	try {
		for (const name of ["3d-plan", "123"]) {
			const skill = path.join(f.root, name, "SKILL.md");
			await Bun.write(skill, `---\nname: ${name}\ndescription: Selected skill\n---\nSKILL_BODY\n`);
			f.config.resources.skills.push(skill);
		}
		const run = await f.run({ action: "commands", commands: ["$3d-plan 需求", "$123 需求", "$50 是价格"] });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult[0]).toMatchObject({ text: "/skill:3d-plan 需求" });
		expect(run.result.actionResult[1]).toMatchObject({ text: "/skill:123 需求" });
		expect(run.result.actionResult[2].handled).not.toBe(true);
		expect(run.result.actionResult[2].text).toBeUndefined();
	} finally {
		await f.close();
	}
}, 30_000);

test("native TUI dispatch expands dollar skills and rejects disabled, unknown and legacy calls without model requests", async () => {
	const f = await fixture();
	try {
		const skill = path.join(f.root, "brainstorming/SKILL.md");
		await Bun.write(skill, "---\nname: brainstorming\ndescription: Plan a feature\n---\nBRAINSTORMING_BODY\n");
		f.config.resources.skills = [skill];
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const resultFile = path.join(f.home, "skill-input-result.json");
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "skill-input-worker.ts"),
				JSON.stringify({ home: f.home, cwd: f.cwd, resultFile }),
			],
			{
				cwd: f.cwd,
				env: {
					PATH: process.env.PATH,
					HOME: os.homedir(),
					TERM: "dumb",
					PRODUCT_TEST_KEY: "fake-local-key",
					PI_CONFIG_DIR: path.relative(os.homedir(), path.join(f.home, "omp")),
					PI_CODING_AGENT_DIR: path.join(f.home, "omp/agent"),
					PI_NATIVES_DIR: path.join(f.home, "natives"),
					OMP_PROFILE: "",
					PI_PROFILE: "",
					OMP_APP_NAME: "my-agent",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, `${stderr}\n${stdout}`).toBe(0);
		const result = await Bun.file(resultFile).json();
		expect(f.requests).toHaveLength(2);
		expect(JSON.stringify(f.requests[0].messages)).toContain("BRAINSTORMING_BODY");
		expect(JSON.stringify(f.requests[0].messages)).toContain("FIRST_SKILL_ARGS");
		expect(JSON.stringify(f.requests[1].messages)).toContain("SECOND_SKILL_ARGS");
		for (const marker of ["DISABLED_MUST_NOT_SEND", "UNKNOWN_MUST_NOT_SEND", "LEGACY_MUST_NOT_SEND"])
			expect(JSON.stringify(f.requests)).not.toContain(marker);
		expect(
			result.messages.filter(
				(message: { role: string; customType?: string }) =>
					message.role === "custom" && message.customType === "skill-prompt",
			),
		).toHaveLength(2);
		expect(result.userTask).toBe("$brainstorming SECOND_SKILL_ARGS");
	} finally {
		await f.close();
	}
}, 30_000);
