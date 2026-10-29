import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config/config";
import { launchPreset, presetDefaults, setPresetDefault } from "../src/presets/defaults";
import { editPreset, type PresetEditorUI } from "../src/presets/editor";
import { readPreset, resolvePreset, samePreset } from "../src/presets/presets";
import { checkPresetDraft, copyPreset, newPresetDraft, openPresetDraft, savePresetDraft } from "../src/presets/store";
import { presetCommand } from "../src/presets/cli";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { RunState } from "../src/runtime/state";
import { productExtension } from "../src/tui/extension";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "preset-management-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	const base: Config = {
		version: 1,
		model: { key: "primary", provider: "opencode-go", id: "deepseek-v4.1-flash", apiKeyEnv: "UNUSED_TEST_KEY" },
		resources: { instructions: [], skills: [], appendSystem: [], extensions: [] },
		permissions: { readRoots: [], writeRoots: [], allowNetwork: false },
		search: { provider: "tavily", apiKeyEnv: "UNUSED_SEARCH_KEY", maxResults: 3 },
		sandbox: { required: true, allowedDomains: [] },
		mcpServers: {},
	};
	await Bun.write(path.join(home, "config.json"), JSON.stringify(base));
	return {
		root,
		home,
		cwd,
		base,
		file: (id: string) => path.join(home, "presets", id, "preset.json"),
		close: () => fs.rm(root, { recursive: true, force: true }),
	};
}

function scripted(steps: string[], input: string[] = [], preview?: () => Promise<void>) {
	const notices: string[] = [];
	const previews: string[] = [];
	const ui: PresetEditorUI = {
		async select(_title, choices) {
			const step = steps.shift();
			if (step === undefined) throw new Error("Unexpected extra editor step");
			const choice = step.startsWith("~") ? choices.find(item => item.includes(step.slice(1))) : step;
			if (!choice || !choices.includes(choice)) throw new Error(`Missing editor choice: ${step}`);
			return choice;
		},
		async input() {
			return input.shift();
		},
		async preview(_title, body) {
			previews.push(body);
			await preview?.();
		},
		notify(message) {
			notices.push(message);
		},
	};
	return { ui, notices, previews };
}

test("preset copies preserve local resource references and exclude history, state and shared credentials", async () => {
	const f = await fixture();
	try {
		await savePresetDraft(f.home, f.cwd, newPresetDraft("source"));
		const rule = path.join(f.home, "presets/source/rules.md");
		await Bun.write(rule, "ONLY_EXPLICIT_RULE");
		const draft = await openPresetDraft(f.home, "source");
		draft.definition.resources.instructions = [{ base: "preset", path: "rules.md" }];
		await savePresetDraft(f.home, f.cwd, draft);
		await Bun.write(path.join(f.home, "presets/source/sessions/private.jsonl"), "PRIVATE_HISTORY");
		const shared = await Bun.file(path.join(f.home, "config.json")).text();
		await copyPreset(f.home, f.cwd, "source", "copied");
		expect((await readPreset(f.home, "copied")).resources.instructions).toEqual([
			{ base: "absolute", path: await fs.realpath(rule) },
		]);
		expect(await fs.readdir(path.dirname(f.file("copied")))).toEqual(["preset.json"]);
		expect(await Bun.file(path.join(f.home, "config.json")).text()).toBe(shared);
		await expect(copyPreset(f.home, f.cwd, "source", "copied")).rejects.toThrow(/存在/);
		await expect(openPresetDraft(f.home, "chat")).rejects.toThrow(/只读/);
	} finally {
		await f.close();
	}
}, 30_000);

test("stale drafts and writer contention preserve the last saved definition", async () => {
	const f = await fixture();
	try {
		await savePresetDraft(f.home, f.cwd, newPresetDraft("work"));
		const first = await openPresetDraft(f.home, "work");
		const stale = await openPresetDraft(f.home, "work");
		first.definition.name = "First saved";
		await savePresetDraft(f.home, f.cwd, first);
		stale.definition.name = "Stale overwrite";
		await expect(savePresetDraft(f.home, f.cwd, stale)).rejects.toThrow(/外部修改/);
		expect((await readPreset(f.home, "work")).name).toBe("First saved");
		const current = await openPresetDraft(f.home, "work");
		await Bun.write(`${f.file("work")}.lock`, "another editor");
		await expect(savePresetDraft(f.home, f.cwd, current)).rejects.toThrow(/编辑器/);
		expect((await readPreset(f.home, "work")).name).toBe("First saved");
	} finally {
		await f.close();
	}
}, 30_000);

test("draft reference validation rejects missing resources and persistent full before writing", async () => {
	const f = await fixture();
	try {
		const draft = newPresetDraft("work");
		draft.definition.resources.instructions = [{ base: "workspace", path: "missing.md" }];
		await expect(savePresetDraft(f.home, f.cwd, draft)).rejects.toThrow();
		expect(await Bun.file(f.file("work")).exists()).toBe(false);
		draft.definition.resources.instructions = [];
		draft.definition.model = { default: "missing", allowed: ["missing"] };
		await expect(checkPresetDraft(f.home, f.cwd, draft)).rejects.toThrow(/模型连接不存在/);
		delete draft.definition.model;
		Object.assign(draft.definition, {
			permissions: { readRoots: [], writeRoots: [], allowNetwork: true, approval: "full" },
		});
		await expect(savePresetDraft(f.home, f.cwd, draft)).rejects.toThrow(/full/);
		expect(await Bun.file(f.file("work")).exists()).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

test("defaults obey explicit, workspace and global precedence without changing shared config or project files", async () => {
	const f = await fixture();
	try {
		for (const id of ["work", "research", "index.json"]) await savePresetDraft(f.home, f.cwd, newPresetDraft(id));
		const shared = await Bun.file(path.join(f.home, "config.json")).text();
		await setPresetDefault(f.home, f.cwd, "global", "work");
		expect(await launchPreset(f.home, f.cwd, {})).toBe("work");
		await setPresetDefault(f.home, f.cwd, "workspace", "research");
		expect(await launchPreset(f.home, f.cwd, {})).toBe("research");
		expect(await launchPreset(f.home, f.cwd, { preset: "bare" })).toBe("bare");
		expect(await launchPreset(f.home, f.cwd, { light: true })).toBeUndefined();
		expect(await launchPreset(f.home, f.cwd, { command: "setup" })).toBeUndefined();
		const alias = path.join(f.root, "alias");
		await fs.symlink(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await launchPreset(f.home, alias, {})).toBe("research");
		await setPresetDefault(f.home, alias, "workspace");
		expect(await launchPreset(f.home, f.cwd, {})).toBe("work");
		await presetCommand(f.home, f.cwd, ["default"], undefined, true);
		expect(await launchPreset(f.home, f.cwd, {})).toBeUndefined();
		expect(await fs.readdir(f.cwd)).toEqual([]);
		expect(await Bun.file(path.join(f.home, "config.json")).text()).toBe(shared);
	} finally {
		await f.close();
	}
}, 30_000);

test("resuming an original session ignores newly selected defaults and rejects foreign paths", async () => {
	const f = await fixture();
	try {
		await savePresetDraft(f.home, f.cwd, newPresetDraft("work"));
		await setPresetDefault(f.home, f.cwd, "global", "chat");
		const named = path.join(f.home, "presets/work/sessions/old.jsonl");
		const legacy = path.join(f.home, "sessions/legacy.jsonl");
		const foreign = path.join(f.cwd, "foreign.jsonl");
		for (const file of [named, legacy, foreign]) await Bun.write(file, "fixture routing only");
		expect(await launchPreset(f.home, f.cwd, { resume: named })).toBe("work");
		expect(await launchPreset(f.home, f.cwd, { resume: legacy })).toBe("legacy");
		expect(await launchPreset(f.home, f.cwd, { resume: named, preset: "bare" })).toBe("bare");
		await expect(launchPreset(f.home, f.cwd, { resume: foreign })).rejects.toThrow(/不属于/);
	} finally {
		await f.close();
	}
}, 30_000);

test("broken defaults fail closed while valid higher-priority choices remain usable", async () => {
	const f = await fixture();
	try {
		await savePresetDraft(f.home, f.cwd, newPresetDraft("work"));
		await setPresetDefault(f.home, f.cwd, "workspace", "work");
		await Bun.write(path.join(f.home, "preset-default.json"), "{broken");
		expect(await launchPreset(f.home, f.cwd, {})).toBe("work");
		await presetCommand(f.home, f.cwd, ["bind", "work"]);
		await fs.unlink(f.file("work"));
		await expect(launchPreset(f.home, f.cwd, {})).rejects.toThrow(/预设不存在/);
		expect(await launchPreset(f.home, f.cwd, { preset: "chat" })).toBe("chat");
		await expect(launchPreset(f.home, f.cwd, { preset: "" })).rejects.toThrow();
		await setPresetDefault(f.home, f.cwd, "workspace");
		await expect(launchPreset(f.home, f.cwd, {})).rejects.toThrow();
	} finally {
		await f.close();
	}
}, 30_000);

test("cancelling a new draft creates no preset and does not mutate the caller's draft", async () => {
	const f = await fixture();
	try {
		const draft = newPresetDraft("cancelled");
		const original = JSON.stringify(draft);
		const script = scripted(["显示名称", "放弃编辑"], ["Unsaved name"]);
		expect(await editPreset(f.home, f.cwd, draft, script.ui)).toBe(false);
		expect(JSON.stringify(draft)).toBe(original);
		expect(await Bun.file(f.file("cancelled")).exists()).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

test("the editor chooses explicit resources, previews a diff and saves only after confirmation", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "rules", "nested.md"), "EXPLICIT_ONLY");
		f.base.resources.instructions = [path.join(f.cwd, "rules", "nested.md")];
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.base));
		await savePresetDraft(f.home, f.cwd, newPresetDraft("work"));
		const original = await openPresetDraft(f.home, "work");
		const script = scripted([
			"指令文件",
			"勾选资源",
			"~未选 · workspace: rules/nested.md",
			"采用本次选择",
			"预览并保存",
			"确认保存",
		]);
		expect(await editPreset(f.home, f.cwd, original, script.ui)).toBe(true);
		expect(script.previews[0]).toContain("rules/nested.md");
		expect((await readPreset(f.home, "work")).resources.instructions).toEqual([
			{ base: "workspace", path: "rules/nested.md" },
		]);
		expect(original.definition.resources.instructions).toEqual([]);
	} finally {
		await f.close();
	}
}, 30_000);

test("an external edit during preview is preserved after the user confirms saving", async () => {
	const f = await fixture();
	try {
		await savePresetDraft(f.home, f.cwd, newPresetDraft("work"));
		const original = await openPresetDraft(f.home, "work");
		const script = scripted(["显示名称", "预览并保存", "确认保存", "放弃编辑"], ["My change"], async () => {
			await Bun.write(f.file("work"), JSON.stringify({ ...original.definition, name: "External edit" }));
		});
		expect(await editPreset(f.home, f.cwd, original, script.ui)).toBe(false);
		expect((await readPreset(f.home, "work")).name).toBe("External edit");
		expect(script.notices.some(text => text.includes("外部修改"))).toBe(true);
	} finally {
		await f.close();
	}
}, 30_000);

test("display-name edits keep restore identity while capability edits require a compatible new session", async () => {
	const f = await fixture();
	try {
		await savePresetDraft(f.home, f.cwd, newPresetDraft("work"));
		const original = (await resolvePreset(f.home, f.cwd, "work", f.base)).identity;
		const draft = await openPresetDraft(f.home, "work");
		draft.definition.name = "New display name";
		await savePresetDraft(f.home, f.cwd, draft);
		expect(samePreset(original, (await resolvePreset(f.home, f.cwd, "work", f.base)).identity)).toBe(true);
		const changed = await openPresetDraft(f.home, "work");
		changed.definition.tools = ["read"];
		await savePresetDraft(f.home, f.cwd, changed);
		expect(samePreset(original, (await resolvePreset(f.home, f.cwd, "work", f.base)).identity)).toBe(false);
		expect((await presetDefaults(f.home, f.cwd)).global).toBeUndefined();
	} finally {
		await f.close();
	}
}, 30_000);

test("model-origin preset commands are blocked before settings or history can change", async () => {
	const f = await fixture();
	try {
		let input: ((event: { source: string; text: string }, ctx: ExtensionContext) => Promise<unknown>) | undefined;
		const api = {
			on(name: string, callback: unknown) {
				if (name === "input") input = callback as typeof input;
			},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		await productExtension(
			{ home: f.home, cwd: f.cwd } as RunState,
			undefined,
			async () => {},
			() => undefined,
		)(api);
		if (!input) throw new Error("Input handler was not registered");
		const notices: string[] = [];
		const ctx = {
			ui: {
				notify(message: string) {
					notices.push(message);
				},
			},
		} as unknown as ExtensionContext;
		for (const text of ["/preset default chat", "/preset bind bare", "/preset copy bare stolen", "/preset edit work"])
			expect(await input({ source: "extension", text }, ctx)).toEqual({ handled: true });
		expect(notices.every(message => message.includes("预设管理") && message.includes("用户主动"))).toBe(true);
		expect(await Bun.file(path.join(f.home, "preset-default.json")).exists()).toBe(false);
		expect(await Bun.file(f.file("stolen")).exists()).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);

test("skill, model, MCP and permission selectors save explicit references without contacting services", async () => {
	const f = await fixture();
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return new Response("Must not connect", { status: 500 });
		},
	});
	try {
		for (const name of ["one", "two"])
			await Bun.write(
				path.join(f.cwd, "skillset", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Explicit candidate\n---\nLOCAL_SKILL_${name}`,
			);
		f.base.models = [{ ...f.base.model, key: "secondary", apiKeyEnv: "UNUSED_SECONDARY_KEY" }];
		f.base.mcpServers.docs = { type: "http", url: `http://127.0.0.1:${server.port}/mcp` };
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.base));
		const script = scripted(
			[
				"技能",
				"添加文件或技能目录",
				"~未选 · workspace: skillset/one/SKILL.md",
				"采用本次选择",
				"工具",
				"~未选 · mcp_list",
				"~未选 · mcp_call",
				"采用本次选择",
				"模型连接",
				"~已选 · primary",
				"~未选 · secondary",
				"采用本次选择",
				"secondary",
				"MCP 服务",
				"~未选 · docs",
				"采用本次选择",
				"权限范围",
				"联网开关",
				"禁止联网",
				"审批方式",
				"auto",
				"采用权限草稿",
				"预览并保存",
				"确认保存",
			],
			[path.join(f.cwd, "skillset")],
		);
		expect(await editPreset(f.home, f.cwd, newPresetDraft("selected"), script.ui)).toBe(true);
		const definition = await readPreset(f.home, "selected");
		expect(definition.resources.skills).toEqual([{ base: "workspace", path: "skillset/one/SKILL.md" }]);
		expect(definition.model).toEqual({ default: "secondary", allowed: ["secondary"] });
		expect(definition.mcpServers).toEqual(["docs"]);
		expect(definition.permissions?.approval).toBe("auto");
		expect(definition.permissions?.allowNetwork).toBe(false);
		expect(requests).toBe(0);
		expect(await Bun.file(f.file("selected")).text()).not.toContain("UNUSED_SECONDARY_KEY");
	} finally {
		server.stop(true);
		await f.close();
	}
}, 30_000);
