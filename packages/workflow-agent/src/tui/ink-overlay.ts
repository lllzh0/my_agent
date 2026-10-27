import type { Component, Container, TUI } from "@oh-my-pi/pi-tui";

export function inkPickerHeight(rows: number): number {
	return Math.max(1, Math.min(Math.floor(rows * 0.9), rows - 2));
}

/** Product panels yield immediately when a real inline dialog needs the keyboard. */
export async function showInkOverlay<T>(
	tui: TUI,
	dock: Container,
	editor: Component,
	signal: AbortSignal,
	factory: (done: (value: T | undefined) => void) => Component,
	fullscreenDocument = false,
): Promise<T | undefined> {
	const activeInline = () => dock.children.at(-1);
	if (signal.aborted || activeInline() !== editor || tui.getFocused() !== editor || tui.hasOverlay()) return;
	const settled = Promise.withResolvers<T | undefined>();
	const checkDialog = () => {
		if (activeInline() === editor) return false;
		settled.resolve(undefined);
		return true;
	};
	// A fullscreen menu can stay byte-identical when a dialog mounts underneath.
	// Such frames emit no paint event; visibility is checked on every render pass.
	const visible = () => !checkDialog();
	const handle = tui.showOverlay(
		factory(value => settled.resolve(value)),
		fullscreenDocument
			? {
					fullscreen: true,
					mouseTracking: false,
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 1,
					visible,
				}
			: {
					fullscreen: true,
					mouseTracking: false,
					anchor: "top-center",
					width: "90%",
					maxHeight: "90%",
					margin: 1,
					visible,
				},
	);
	const removeInput = tui.addInputListener(() => (checkDialog() ? { consume: true } : undefined));
	const abort = () => settled.resolve(undefined);
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await settled.promise;
	} finally {
		signal.removeEventListener("abort", abort);
		removeInput();
		handle.hide();
		// The old preFocus can point at the editor even though an approval replaced it.
		const current = activeInline();
		if (!signal.aborted && current && !tui.hasOverlay()) tui.setFocus(current);
		tui.requestRender();
	}
}
