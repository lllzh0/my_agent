import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RunState } from "../runtime/state";
import type { PresetTarget } from "../presets/handoff-protocol";

/** The controller owns the lifetime; a platform cold start may exceed the input hook's 30s budget. */
export function requestPresetTransition(state: RunState, ctx: ExtensionContext, target: PresetTarget): void {
	ctx.signal?.throwIfAborted();
	if (!state.handoff) throw new Error("预设交接需要从产品 launcher 的交互终端启动。");
	void state.handoff
		.switch(target)
		.catch(error =>
			ctx.ui.notify(replaceTabs(sanitizeText(error instanceof Error ? error.message : String(error))), "error"),
		);
}
