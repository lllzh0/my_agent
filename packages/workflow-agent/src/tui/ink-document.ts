import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Read-only inspection panel; copying never edits a diff or source record. */
export class InkDocument implements Component {
	#offset = 0;
	#total = 0;
	constructor(
		readonly title: string,
		readonly body: string,
		readonly height: () => number,
		readonly close: () => void,
	) {}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		const page = Math.max(1, this.height() - 4);
		if (matchesKey(data, "up")) this.#offset--;
		if (matchesKey(data, "down")) this.#offset++;
		if (matchesKey(data, "pageUp")) this.#offset -= page;
		if (matchesKey(data, "pageDown") || data === " ") this.#offset += page;
		if (matchesKey(data, "home")) this.#offset = 0;
		if (matchesKey(data, "end")) this.#offset = this.#total;
		this.#offset = Math.max(0, Math.min(this.#offset, Math.max(0, this.#total - page)));
	}
	render(width: number): string[] {
		const rows = sanitizeText(this.body)
			.replaceAll("\t", "    ")
			.split("\n")
			.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
		const page = Math.max(1, this.height() - 4);
		this.#total = rows.length;
		this.#offset = Math.max(0, Math.min(this.#offset, Math.max(0, rows.length - page)));
		return [
			theme.fg("accent", truncateToWidth(sanitizeText(this.title).replace(/\s+/g, " "), width)),
			theme.fg("dim", "─".repeat(width)),
			...rows
				.slice(this.#offset, this.#offset + page)
				.map(line =>
					line.startsWith("+") ? theme.fg("success", line) : line.startsWith("-") ? theme.fg("error", line) : line,
				),
			"",
			theme.fg(
				"dim",
				truncateToWidth(
					`↑↓ / PgUp PgDn 滚动 · Esc 返回   ${this.#offset + 1}–${Math.min(this.#offset + page, rows.length)}/${rows.length}`,
					width,
				),
			),
		];
	}
}
