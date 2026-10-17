import type { RunState } from "../runtime/state";
import type { Change } from "./journal";

export function latestFileTurn(state: Pick<RunState, "journal">): Change[] {
	return state.journal.latestTurn();
}

/** One approval covers the selected files; recheck after approval and queue waits. */
export async function restoreFileChanges(
	state: Pick<RunState, "cwd" | "policy" | "journal" | "jobs">,
	changes: Change[],
	ensureIdle: () => void,
): Promise<void> {
	const request = {
		tool: "file-restore",
		kind: "write" as const,
		target: state.cwd,
		parameters: {
			changes: changes.map(change => change.id),
			files: [...new Set(changes.map(change => change.path))],
		},
	};
	const beforeWrite = () => {
		ensureIdle();
		if (state.jobs.hasActiveJobs) throw new Error("后台任务仍在运行；先停止任务再恢复文件。");
		state.policy.checkMode(request);
	};
	const validate = async () => {
		beforeWrite();
		for (const change of changes) {
			if ((await state.policy.resolvePath(change.path, "write")) !== change.path)
				throw new Error("恢复路径发生变化");
		}
		beforeWrite();
	};
	await validate();
	await state.policy.authorize(request);
	await state.journal.restoreMany(request.parameters.changes, { prepare: validate, beforeWrite });
}
