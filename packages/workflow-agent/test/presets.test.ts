import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config/config";
import {
	builtinPreset,
	resolvePreset,
	samePreset,
	validatePreset,
	presetId,
	type PresetDefinition,
} from "../src/presets/presets";
import { presetCommand } from "../src/presets/cli";

async function setup() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-presets-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "work");
	await fs.mkdir(home);
	await fs.mkdir(cwd);
	const config: Config = {
		version: 1,
		model: { key: "primary", provider: "opencode-go", id: "deepseek-v4.1-flash", apiKeyEnv: "TEST_KEY" },
		models: [{ key: "other", provider: "opencode-go", id: "other", apiKeyEnv: "OTHER_KEY" }],
		resources: {
			instructions: ["UNSELECTED_GLOBAL_RULE"],
			skills: ["UNSELECTED_SKILL"],
			appendSystem: ["UNSELECTED_PROMPT"],
			extensions: [],
		},
		permissions: { readRoots: [], writeRoots: [], allowNetwork: false },
		search: { provider: "tavily", apiKeyEnv: "SEARCH_KEY", maxResults: 3 },
		sandbox: { required: true, allowedDomains: [] },
		mcpServers: { a: { type: "http", url: "https://example.com/mcp" }, b: { command: "MUST_NOT_SPAWN", args: [] } },
	};
	await Bun.write(path.join(home, "config.json"), JSON.stringify(config));
	return {
		root,
		home,
		cwd,
		config,
		close: () => fs.rm(root, { recursive: true, force: true }),
		async save(definition: PresetDefinition) {
			await Bun.write(path.join(home, "presets", definition.id, "preset.json"), JSON.stringify(definition));
		},
	};
}

test("A/B compilation excludes ambient resources, unused model connections and MCP servers", async () => {
	const f = await setup();
	try {
		await Bun.write(path.join(f.cwd, "a.md"), "ONLY_A");
		await Bun.write(path.join(f.cwd, "b.md"), "ONLY_B");
		const a: PresetDefinition = {
			...builtinPreset("bare"),
			id: "a",
			name: "A",
			tools: ["read", "mcp_list", "mcp_call"],
			mcpServers: ["a"],
			resources: { instructions: [{ base: "workspace", path: "a.md" }], skills: [], appendSystem: [] },
		};
		const b: PresetDefinition = {
			...builtinPreset("bare"),
			id: "b",
			name: "B",
			tools: ["read"],
			model: { default: "other", allowed: ["other"] },
			resources: { instructions: [{ base: "workspace", path: "b.md" }], skills: [], appendSystem: [] },
		};
		await f.save(a);
		await f.save(b);
		const first = await resolvePreset(f.home, f.cwd, "a", f.config);
		const second = await resolvePreset(f.home, f.cwd, "b", f.config);
		expect(await Bun.file(first.config.resources.instructions[0]).text()).toBe("ONLY_A");
		expect(await Bun.file(second.config.resources.instructions[0]).text()).toBe("ONLY_B");
		expect(first.config.resources.skills).toEqual([]);
		expect(first.config.resources.appendSystem).toEqual([]);
		expect(Object.keys(first.config.mcpServers)).toEqual(["a"]);
		expect(second.config.mcpServers).toEqual({});
		expect(second.config.model.apiKeyEnv).toBe("OTHER_KEY");
		expect(second.config.models).toEqual([]);
		expect(first.sessionDir).not.toBe(second.sessionDir);
		expect(first.agentDir).not.toBe(second.agentDir);
		expect(first.config.resources.disabled).toContain("tool:write");
		expect(f.config.resources.instructions).toEqual(["UNSELECTED_GLOBAL_RULE"]);
		await f.save({ ...a, name: "重命名" });
		expect(samePreset(first.identity, (await resolvePreset(f.home, f.cwd, "a", f.config)).identity)).toBe(true);
		await f.save({ ...a, tools: [...a.tools, "ls"] });
		expect(samePreset(first.identity, (await resolvePreset(f.home, f.cwd, "a", f.config)).identity)).toBe(false);
	} finally {
		await f.close();
	}
});

test("pure chat compiles to an empty resource and capability selection", async () => {
	const f = await setup();
	try {
		const resolved = await resolvePreset(f.home, f.cwd, "chat", f.config);
		expect(resolved.light).toBe(true);
		expect(resolved.definition.tools).toEqual([]);
		expect(resolved.config.resources.instructions).toEqual([]);
		expect(resolved.config.resources.skills).toEqual([]);
		expect(resolved.config.mcpServers).toEqual({});
		expect(resolved.config.resources.disabled).toContain("tool:goal");
	} finally {
		await f.close();
	}
});

test("invalid capabilities, implicit dependencies and persistent full grants fail before execution", () => {
	const base = builtinPreset("bare");
	expect(() => validatePreset({ ...base, tools: ["eval"] })).toThrow(/未知/);
	expect(() => validatePreset({ ...base, tools: ["bash"] })).toThrow(/job_output/);
	expect(() => validatePreset({ ...base, tools: ["mcp_call"], mcpServers: [] })).toThrow(/MCP/);
	expect(() =>
		validatePreset({ ...base, permissions: { readRoots: [], writeRoots: [], allowNetwork: true, approval: "full" } }),
	).toThrow(/full/);
	expect(() => validatePreset({ ...builtinPreset("chat"), tools: ["read"] })).toThrow(/chat/);
	expect(() => presetId("../escape")).toThrow();
	expect(() => presetId("con.txt")).toThrow();
	expect(() => presetId("default")).toThrow();
});

test("workspace escapes, missing resources and directory-shaped skills cannot silently start", async () => {
	const f = await setup();
	try {
		await Bun.write(path.join(f.root, "outside.md"), "outside");
		const definition = {
			...builtinPreset("bare"),
			id: "work",
			resources: {
				instructions: [{ base: "workspace" as const, path: "../outside.md" }],
				skills: [],
				appendSystem: [],
			},
		};
		await f.save(definition);
		await expect(resolvePreset(f.home, f.cwd, "work", f.config)).rejects.toThrow(/超出/);
		await f.save({
			...definition,
			resources: { instructions: [], appendSystem: [], skills: [{ base: "workspace", path: "." }] },
		});
		await expect(resolvePreset(f.home, f.cwd, "work", f.config)).rejects.toThrow(/SKILL.md/);
		await f.save({
			...definition,
			resources: { instructions: [{ base: "workspace", path: "missing.md" }], appendSystem: [], skills: [] },
		});
		await expect(resolvePreset(f.home, f.cwd, "work", f.config)).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("session ownership rejects other presets, changed definitions and accidental legacy mixing", () => {
	const identity = { version: 1 as const, id: "a", signature: "snapshot-a" };
	expect(samePreset({ ...identity }, identity)).toBe(true);
	expect(samePreset({ ...identity, id: "b" }, identity)).toBe(false);
	expect(samePreset({ ...identity, signature: "changed" }, identity)).toBe(false);
	expect(samePreset(undefined, identity)).toBe(false);
	expect(samePreset(identity)).toBe(false);
	expect(samePreset(undefined)).toBe(true);
});

test("create/show/check preserve shared config, do not overwrite definitions and expose missing references", async () => {
	const f = await setup();
	try {
		const original = await Bun.file(path.join(f.home, "config.json")).text();
		await presetCommand(f.home, f.cwd, ["create", "research"], "research");
		const file = path.join(f.home, "presets", "research", "preset.json");
		const saved = await Bun.file(file).text();
		await expect(presetCommand(f.home, f.cwd, ["create", "research"])).rejects.toThrow();
		expect(await Bun.file(file).text()).toBe(saved);
		const checked = JSON.stringify(await presetCommand(f.home, f.cwd, ["check", "research"]));
		expect(checked).not.toContain("UNSELECTED_GLOBAL_RULE");
		expect(checked).not.toContain("MUST_NOT_SPAWN");
		expect(await Bun.file(path.join(f.home, "config.json")).text()).toBe(original);
		const definition = JSON.parse(saved) as PresetDefinition;
		definition.model = { default: "missing", allowed: ["missing"] };
		await f.save(definition);
		await expect(presetCommand(f.home, f.cwd, ["check", "research"])).rejects.toThrow(/连接不存在/);
	} finally {
		await f.close();
	}
});
