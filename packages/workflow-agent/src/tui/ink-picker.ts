import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export interface InkChoice {
	value: string;
	label: string;
	description?: string;
}

/** A keyboard-only overlay: its draft is separate from the conversation editor. */
export class InkPicker implements Component, Focusable {
	readonly #input = new Input();
	#selected = 0;
	constructor(
		readonly title: string,
		readonly choices: readonly InkChoice[],
		readonly done: (value: string | undefined) => void,
		readonly height: () => number,
	) {
		this.#input.prompt = "搜索 › ";
	}
	get focused(): boolean {
		return this.#input.focused;
	}
	set focused(value: boolean) {
		this.#input.focused = value;
	}
	setUseTerminalCursor(value: boolean): void {
		this.#input.setUseTerminalCursor(value);
	}
	#matches(): readonly InkChoice[] {
		const words = this.#input.getValue().trim().toLocaleLowerCase().split(/\s+/);
		return this.choices.filter(item =>
			words.every(word =>
				`${item.label} ${item.description ?? ""} ${item.value}`.toLocaleLowerCase().includes(word),
			),
		);
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}
		const items = this.#matches();
		if (matchesKey(data, "enter")) {
			if (items[this.#selected]) this.done(items[this.#selected]!.value);
			return;
		}
		if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down")) this.#selected = Math.min(Math.max(0, items.length - 1), this.#selected + 1);
		else {
			this.#input.handleInput(data);
			this.#selected = 0;
		}
	}
	render(width: number): string[] {
		const clean = (value: string) => truncateToWidth(sanitizeText(value).replace(/\s+/g, " "), Math.max(1, width));
		const matches = this.#matches();
		const count = Math.max(1, this.height() - 7);
		const start = Math.max(0, this.#selected - count + 1);
		return [
			theme.fg("accent", clean(` ${this.title}`)),
			theme.fg("dim", "─".repeat(Math.max(1, width))),
			...this.#input.render(Math.max(1, width)),
			"",
			...(matches.length
				? matches.slice(start, start + count).map((item, i) => {
						const label = clean(
							`${start + i === this.#selected ? "›" : " "} ${item.label}${item.description ? `  · ${item.description}` : ""}`,
						);
						return start + i === this.#selected ? theme.fg("accent", label) : label;
					})
				: [theme.fg("dim", clean("无匹配项"))]),
			"",
			theme.fg(
				"dim",
				clean(`↑↓ 选择 · Enter 确认 · Esc 返回  ${matches.length ? this.#selected + 1 : 0}/${matches.length}`),
			),
		];
	}
}
