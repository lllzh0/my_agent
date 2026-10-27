import { beforeAll, expect, test } from "bun:test";
import { Composer, type ComposerFrameDecoration } from "../src/prompt/composer";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { Text } from "../src/components/text";
import { initTheme } from "../src/theme/theme";
import { visibleWidth } from "../src/utils";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(() => initTheme());

const decoration: ComposerFrameDecoration = {
	measure: ({ columns, rows }) => ({ top: rows >= 10 ? 2 : 0, left: columns >= 80 ? 20 : 0 }),
	render: (viewport, content, insets) => [
		...Array<string>(insets.top).fill("Workspace"),
		...content.map(line => " ".repeat(insets.left) + line),
	],
};

test("decorated composer keeps the input docked and hit targets aligned through narrow resize", () => {
	const composer = new Composer({ terminal: new VirtualTerminal(100, 24), preferences: { quiet: true } });
	composer.start();
	try {
		const transcript = new TranscriptContainer();
		const block = {
			render: (width: number) => ["结果".repeat(Math.floor(width / 4))],
			getClickFocusAgentIds: () => ["worker"],
		};
		transcript.addChild(block);
		composer.setRuntimeChildren([transcript, new Text("INPUT", 0, 0)]);
		composer.setFrameDecoration(decoration);
		const frame = composer.renderFrame({ columns: 100, rows: 24 });
		expect(frame.viewport).toHaveLength(24);
		expect(Bun.stripANSI(frame.viewport.at(-1)!)).toContain("INPUT");
		expect(frame.viewport.every(line => visibleWidth(line) <= 100)).toBe(true);
		expect(composer.viewportClickCandidates(0)).toEqual([]);
		const row = frame.viewport.findIndex(line => line.includes("结果"));
		expect(composer.viewportClickCandidates(row)).toEqual(["worker"]);
		expect(composer.viewportClickCandidates(22)).toEqual([]);
		const narrow = composer.renderFrame({ columns: 40, rows: 12 });
		expect(narrow.viewport).toHaveLength(12);
		expect(narrow.viewport.every(line => visibleWidth(line) <= 40)).toBe(true);
		expect(narrow.viewport.at(-1)).toContain("INPUT");
		const resizing = composer.renderResizeFrame({ columns: 40, rows: 12 });
		expect(resizing).toHaveLength(12);
		expect(resizing.at(-1)).toContain("INPUT");
	} finally {
		composer.stop();
	}
});

test("decoration never enters committed transcript history or duplicates accepted batches", () => {
	const composer = new Composer({ terminal: new VirtualTerminal(100, 14), preferences: { quiet: true } });
	composer.start();
	try {
		const transcript = new TranscriptContainer();
		for (let n = 0; n < 30; n++) {
			const block = { render: () => [`message ${n}`], isTranscriptBlockFinalized: () => true };
			transcript.addChild(block);
		}
		composer.setRuntimeChildren([transcript, new Text("INPUT", 0, 0)]);
		composer.setFrameDecoration(decoration);
		const seen = new Set<number>();
		const history: string[] = [];
		for (let n = 0; n < 40; n++) {
			const frame = composer.renderFrame({ columns: 100, rows: 14 });
			if (!frame.history) break;
			expect(seen.has(frame.history.id)).toBe(false);
			seen.add(frame.history.id);
			history.push(...frame.history.rows);
			composer.acknowledgeHistory(frame.history.id);
		}
		expect(history.join("\n")).toContain("message 0");
		expect(history.join("\n")).not.toContain("Workspace");
		expect(history.filter(line => line === "message 0")).toHaveLength(1);
	} finally {
		composer.stop();
	}
});
