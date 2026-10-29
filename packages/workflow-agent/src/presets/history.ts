import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listSessionsReadOnly, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { presetId } from "./presets";
import { contained } from "../policy/paths";
import { readJson, record } from "../storage";

export interface PresetSessionInfo extends SessionInfo {
	preset: string;
}
export async function presetHistory(
	home: string,
	cwd: string,
	id: string,
	exclude?: string,
): Promise<PresetSessionInfo[]> {
	presetId(id);
	const directory = path.join(home, ...(id === "legacy" ? ["sessions"] : ["presets", id, "sessions"]));
	let root: string;
	try {
		root = await fs.realpath(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!contained(await fs.realpath(home), root)) throw new Error("会话目录超出当前配置目录。");
	const result: PresetSessionInfo[] = [];
	for (const info of await listSessionsReadOnly(root, new FileSessionStorage())) {
		try {
			if (
				info.id === exclude ||
				!contained(root, await fs.realpath(info.path)) ||
				(await fs.realpath(info.cwd)) !== cwd
			)
				continue;
			const manifest = record(await readJson(path.join(home, "state", info.id, "manifest.json")), "会话记录");
			if (
				manifest.sessionId !== info.id ||
				manifest.cwd !== cwd ||
				((manifest.preset as { id?: string } | undefined)?.id ?? "legacy") !== id
			)
				continue;
			result.push({ ...info, preset: id });
		} catch {
			/* Foreign or incomplete histories never become handoff targets. */
		}
	}
	return result.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
