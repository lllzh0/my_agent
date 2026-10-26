import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";

/** A skill command occupies the leading token; prose and shell expressions stay text. */
export function parseProductSkill(text: string): { name: string; args: string } | undefined {
	const match = /^[ \t]*\$([a-zA-Z0-9_][a-zA-Z0-9_./:-]*)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
	if (match) return { name: match[1], args: (match[2] ?? "").trim() };
}

export function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	skills: () => readonly Skill[],
): AutocompleteProvider {
	const prefixAtCursor = (lines: string[], cursorLine: number, cursorCol: number): string | undefined => {
		if (cursorLine !== 0) return;
		const before = (lines[0] ?? "").slice(0, cursorCol);
		if (/^[ \t]*\$[^\s]*$/.test(before)) return before;
	};
	const skillSuggestions: NonNullable<AutocompleteProvider["trySyncSuggestions"]> = (lines, cursorLine, cursorCol) => {
		const prefix = prefixAtCursor(lines, cursorLine, cursorCol);
		if (prefix === undefined) return null;
		const query = prefix.trimStart().slice(1).toLowerCase();
		return {
			prefix,
			items: skills()
				.filter(skill => skill.name.toLowerCase().startsWith(query))
				.map(skill => ({
					value: `$${skill.name}`,
					label: `$${skill.name}`,
					description: skill.description,
					iconName: "skill",
				})),
		};
	};
	return {
		async getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
			if (signal?.aborted) return null;
			const suggestions = skillSuggestions(lines, cursorLine, cursorCol);
			if (!suggestions) return current.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);
			return suggestions.items.length ? suggestions : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const livePrefix = prefixAtCursor(lines, cursorLine, cursorCol);
			if (livePrefix === undefined || !item.value.startsWith("$"))
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const indent = livePrefix.slice(0, livePrefix.indexOf("$"));
			const suffix = lines[cursorLine].slice(cursorCol).replace(/^\S*[ \t]*/, "");
			const insert = `${indent}${item.value} `;
			const completed = [...lines];
			completed[cursorLine] = insert + suffix;
			return { lines: completed, cursorLine, cursorCol: insert.length };
		},
		getInlineHint: current.getInlineHint?.bind(current),
		trySyncSuggestions(lines, cursorLine, cursorCol) {
			return (
				skillSuggestions(lines, cursorLine, cursorCol) ??
				current.trySyncSuggestions?.(lines, cursorLine, cursorCol) ??
				null
			);
		},
		trySyncSlashCompletion: current.trySyncSlashCompletion?.bind(current),
		trySyncInlineReplace: current.trySyncInlineReplace?.bind(current),
		async getForceFileSuggestions(lines, cursorLine, cursorCol, signal) {
			if (prefixAtCursor(lines, cursorLine, cursorCol) !== undefined) return null;
			return (await current.getForceFileSuggestions?.(lines, cursorLine, cursorCol, signal)) ?? null;
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (prefixAtCursor(lines, cursorLine, cursorCol) !== undefined) return false;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}
