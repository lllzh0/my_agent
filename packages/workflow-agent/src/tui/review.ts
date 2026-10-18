import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { BorderedLoader } from "@oh-my-pi/pi-tui/overlays/bordered-loader";
import type { RunState } from "../runtime/state";
import type { ProductReviewResult } from "../review/runner";

export async function reviewFromCommand(
	state: RunState,
	ctx: ExtensionContext,
	base?: string,
): Promise<ProductReviewResult> {
	const review = state.review;
	if (!review) throw new Error("代码审查尚未初始化。");
	if (ctx.mode !== "tui" || !ctx.hasUI) return review.run(base, ctx.signal);
	let running: Promise<ProductReviewResult> | undefined;
	try {
		const outcome = await ctx.ui.custom<{ result?: ProductReviewResult; error?: unknown }>(
			(tui, theme, _keys, done) => {
				const loader = new BorderedLoader(tui, theme, "只读审查代码中；按 Esc 取消");
				const signal = AbortSignal.any([loader.signal, ...(ctx.signal ? [ctx.signal] : [])]);
				running = Promise.resolve().then(() => review.run(base, signal));
				void running.then(
					result => done({ result }),
					error => done({ error }),
				);
				return loader;
			},
			{ signal: ctx.signal },
		);
		if (outcome?.error) throw outcome.error;
		if (!outcome?.result) throw new Error("审查已取消。");
		return outcome.result;
	} finally {
		// Keep the transition locked until native request cleanup and usage have
		// settled, including when the containing UI is closed or cancelled.
		if (ctx.signal?.aborted) review.cancel();
		await running?.catch(() => {});
	}
}
