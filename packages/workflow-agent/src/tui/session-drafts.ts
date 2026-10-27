import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import type { TUI } from "@oh-my-pi/pi-tui";

interface Draft {
	text: string;
	images: ImageContent[];
	links: (string | undefined)[];
}

/** Process-local drafts follow the actual committed session, even when UI refresh throws. */
export class SessionDrafts {
	readonly #drafts = new Map<string, Draft>();
	constructor(
		readonly editor: () => CustomEditor,
		readonly sessionKey: () => string,
		readonly tui: TUI,
		readonly onReady: (discarded: boolean) => void = () => {},
	) {}
	async switch(operation: () => Promise<void>): Promise<void> {
		const editor = this.editor();
		this.#drafts.set(this.sessionKey(), {
			text: editor.getExpandedText(),
			images: [...editor.pendingImages],
			links: [...editor.pendingImageLinks],
		});
		let discarded = false;
		const releaseInput = this.tui.addInputListener(() => {
			discarded = true;
			return { consume: true };
		});
		try {
			await operation();
		} finally {
			try {
				const draft = this.#drafts.get(this.sessionKey());
				const current = this.editor();
				current.clearDraft();
				if (draft) {
					current.setDraft(draft.text, draft.images);
					current.pendingImageLinks = [...draft.links];
					current.imageLinks = current.pendingImageLinks;
				}
			} finally {
				this.tui.terminal.discardPendingInput?.();
				releaseInput();
				this.onReady(discarded);
			}
		}
	}
}
