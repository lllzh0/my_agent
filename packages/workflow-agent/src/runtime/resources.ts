import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearCache as clearDiscoveryFileCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Config } from "../config/config";
import { digest } from "../storage";
import systemTemplate from "../prompts/system.md" with { type: "text" };
import lightPrompt from "../prompts/light.md" with { type: "text" };

export interface ResourceEntry {
	id?: string;
	kind: string;
	path: string;
	hash?: string;
	selected: boolean;
	loaded: boolean;
	advertised?: boolean;
	bodyLoaded?: boolean;
	name?: string;
}

export function resourceDisabled(config: Config, id: string): boolean {
	return config.resources.disabled?.includes(id) === true;
}
export interface Resources {
	entries: ResourceEntry[];
	instructions: { path: string; content: string }[];
	skills: Skill[];
	systemPrompt: string;
	signature: string;
}

export async function loadResources(config: Config, cwd: string, light: boolean): Promise<Resources> {
	const entries: ResourceEntry[] = [];
	const instructions: Resources["instructions"] = [];
	const skills: Skill[] = [];
	const systemAdditions: string[] = [];
	const read = async (kind: string, input: string) => {
		const file = path.resolve(cwd, input);
		const id = `${kind}:${file}`;
		if (resourceDisabled(config, id)) {
			entries.push({ id, kind, path: file, selected: false, loaded: false });
			return;
		}
		if ((await fs.stat(file)).size > 1_000_000) throw new Error(`指令文件超过 1MB：${file}`);
		const content = await Bun.file(file).text();
		entries.push({ kind, path: file, hash: digest(content), selected: true, loaded: true });
		return { path: file, content };
	};
	if (!light) {
		if (config.resources.extensions.some(extension => extension.enabled)) {
			throw new Error("OMP 产品入口暂未接入第三方代码扩展；请关闭已选扩展后启动，文件尚未执行。");
		}
		for (const input of config.resources.instructions) {
			const instruction = await read("instruction", input);
			if (instruction) instructions.push(instruction);
		}
		for (const input of [config.resources.systemPrompt, ...config.resources.appendSystem]) {
			if (input) {
				const addition = await read("system", input);
				if (addition) systemAdditions.push(addition.content);
			}
		}
		// Native discovery caches file contents; explicit reload must read fresh metadata.
		if (config.resources.skills.length) clearDiscoveryFileCache();
		for (const input of config.resources.skills) {
			const selected = await fs.realpath(path.resolve(cwd, input));
			const isFile = (await fs.stat(selected)).isFile();
			if (isFile && path.basename(selected) !== "SKILL.md") throw new Error("技能文件必须命名为 SKILL.md");
			const loaded = await scanSkillsFromDir(
				{ cwd, home: cwd, repoRoot: null },
				{
					dir: isFile ? path.dirname(selected) : selected,
					providerId: "my-agent",
					level: "user",
					requireDescription: true,
					includeSelf: true,
					includeChildren: !isFile,
				},
			);
			if (loaded.warnings?.length) throw new Error(loaded.warnings.join("; "));
			const selectedItems = isFile
				? loaded.items.filter(skill => path.resolve(skill.path) === selected)
				: loaded.items;
			const matching: Skill[] = selectedItems.map(item => ({
				name: item.name,
				description: typeof item.frontmatter?.description === "string" ? item.frontmatter.description : "",
				filePath: item.path,
				baseDir: path.dirname(item.path),
				source: "my-agent:user",
				hide: item.frontmatter?.hide === true || item.frontmatter?.disableModelInvocation === true,
				_source: item._source,
			}));
			if (!matching.length) throw new Error(`未找到有效技能：${selected}`);
			for (const skill of matching) {
				if (entries.some(existing => existing.kind === "skill" && existing.name === skill.name))
					throw new Error(`技能名称重复：${skill.name}`);
				const enabled = !resourceDisabled(config, `skill:${skill.name}`);
				if (enabled) skills.push(skill);
				entries.push({
					kind: "skill",
					path: skill.filePath,
					name: skill.name,
					hash: digest(await Bun.file(skill.filePath).text()),
					selected: enabled,
					loaded: enabled,
					advertised: enabled && !skill.hide,
					bodyLoaded: false,
				});
			}
		}
	}
	for (const extension of config.resources.extensions)
		entries.push({
			kind: "extension",
			path: path.resolve(cwd, extension.path),
			selected: extension.enabled,
			loaded: false,
		});
	const systemPrompt = light
		? lightPrompt
		: prompt.render(systemTemplate, { instructions, systemAdditions, skills: skills.filter(skill => !skill.hide) });
	return {
		entries,
		instructions,
		skills,
		systemPrompt,
		signature: digest(JSON.stringify({ config, light, entries })),
	};
}
