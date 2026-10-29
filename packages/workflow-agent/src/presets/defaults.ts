import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicJson, digest, readJson, record } from "../storage";
import { presetId, readPreset } from "./presets";
import { checkPresetDraft, presetStoragePath } from "./store";

async function workspacePath(cwd: string): Promise<string> {
	const real = await fs.realpath(cwd);
	return process.platform === "win32" ? real.toLowerCase() : real;
}

function defaultId(value: unknown, cwd?: string): string | undefined {
	if (value === undefined) return undefined;
	const data = record(value, "预设默认记录");
	if (data.version !== 1 || typeof data.preset !== "string" || (cwd !== undefined && data.cwd !== cwd))
		throw new Error("预设默认记录无效或不属于当前工作区，请重新绑定");
	return presetId(data.preset);
}

export async function presetDefaults(
	home: string,
	cwd: string,
): Promise<{ global?: string; workspace?: string; cwd: string }> {
	const canonical = await workspacePath(cwd);
	return {
		global: defaultId(await readJson(path.join(home, "preset-default.json"))),
		workspace: defaultId(await readJson(path.join(home, "workspaces", digest(canonical), "preset.json")), canonical),
		cwd: canonical,
	};
}

export async function setPresetDefault(
	home: string,
	cwd: string,
	scope: "global" | "workspace",
	id?: string,
): Promise<void> {
	if (id !== undefined) {
		presetId(id);
		if (id !== "legacy") await checkPresetDraft(home, cwd, { id, definition: await readPreset(home, id) });
	}
	const canonical = await workspacePath(cwd);
	const file = await presetStoragePath(
		home,
		scope === "global" ? ["preset-default.json"] : ["workspaces", digest(canonical), "preset.json"],
	);
	if (id === undefined) {
		await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		return;
	}
	await atomicJson(file, { version: 1, preset: id, ...(scope === "workspace" ? { cwd: canonical } : {}) });
}

/** Routing is a hint only. The host still validates ownership, identity and resources. */
export async function launchPreset(
	home: string,
	cwd: string,
	options: {
		preset?: string;
		resume?: string;
		light?: boolean;
		command?: string;
		help?: boolean;
	},
): Promise<string | undefined> {
	if (options.preset !== undefined) {
		if (options.light) throw new Error("--preset 与 --light 不能同时使用");
		return presetId(options.preset);
	}
	if (
		options.light ||
		options.help ||
		["setup", "restore-config", "doctor", "diagnose"].includes(options.command ?? "")
	)
		return;
	if (options.resume) {
		const root = await fs.realpath(home);
		const file = await fs.realpath(path.resolve(cwd, options.resume));
		const parts = path.relative(root, file).split(path.sep);
		if (parts.length === 2 && parts[0] === "sessions") return "legacy";
		if (parts.length === 4 && parts[0] === "presets" && parts[2] === "sessions") return presetId(parts[1]);
		throw new Error("恢复文件不属于当前配置目录的产品会话；请使用原 home 和恢复命令");
	}
	const canonical = await workspacePath(cwd);
	const workspace = defaultId(
		await readJson(path.join(home, "workspaces", digest(canonical), "preset.json")),
		canonical,
	);
	const id = workspace ?? defaultId(await readJson(path.join(home, "preset-default.json")));
	if (id && id !== "legacy") await readPreset(home, id);
	return id;
}
