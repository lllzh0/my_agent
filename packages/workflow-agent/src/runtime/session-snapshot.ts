import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ModelSelection } from "../models/controller";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { atomicJson, readJson, record } from "../storage";
import type { RunState } from "./state";

export interface SessionSnapshot {
	version: 1;
	model: ModelSelection;
	plan: boolean;
}
export function readSessionSnapshot(manifest: unknown): SessionSnapshot | undefined {
	if (!manifest || typeof manifest !== "object") return;
	const value = (manifest as Record<string, unknown>).runtime;
	if (value === undefined) return;
	const snapshot = record(value, "会话运行选择");
	const model = record(snapshot.model, "会话模型选择");
	if (snapshot.version !== 1 || typeof snapshot.plan !== "boolean" || typeof model.model !== "string" || !model.model)
		throw new Error("会话运行选择无效。");
	const effort = typeof model.effort === "string" ? parseConfiguredThinkingLevel(model.effort) : undefined;
	if (model.effort !== undefined && !effort) throw new Error("会话思考强度无效。");
	return { version: 1, model: { model: model.model, effort }, plan: snapshot.plan };
}
export async function saveSessionSnapshot(state: RunState, session: AgentSession): Promise<void> {
	if (state.snapshotWritable === false) return;
	await session.flushToDisk();
	if (!state.preset || !state.models) return;
	const file = path.join(state.stateDir, "manifest.json");
	const manifest = record(await readJson(file), "会话记录");
	await atomicJson(file, {
		...manifest,
		runtime: {
			version: 1,
			model: { model: state.models.current().key, effort: session.configuredThinkingLevel() },
			plan: state.policy.mode === "plan",
		},
	});
}
