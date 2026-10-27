import { beforeAll, expect, test } from "bun:test";
import { Container, Input, TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { showInkOverlay, inkPickerHeight } from "../src/tui/ink-overlay";
import { InkPicker } from "../src/tui/ink-picker";

beforeAll(() => initTheme());

test("an approval replaces an already painted unchanged fullscreen menu without another keystroke", async () => {
	const term = new VirtualTerminal(100, 30);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const editor = new Input();
	const dock = new Container();
	dock.addChild(editor);
	tui.addChild(dock);
	tui.setFocus(editor);
	tui.start();
	const controller = new AbortController();
	try {
		const result = showInkOverlay(
			tui,
			dock,
			editor,
			controller.signal,
			done => new InkPicker("操作面板", [{ value: "x", label: "X" }], done, () => 20),
		);
		await scheduler.settle(term);
		expect(term.getViewport().join("\n")).toContain("操作面板");
		const approval = new Input();
		approval.prompt = "批准 write › ";
		dock.clear();
		dock.addChild(approval);
		tui.setFocus(approval);
		tui.requestRender();
		await scheduler.settle(term);
		expect(tui.hasOverlay()).toBe(false);
		expect(tui.getFocused()).toBe(approval);
		expect(term.getViewport().join("\n")).toContain("批准 write");
		expect(await result).toBeUndefined();
	} finally {
		controller.abort();
		tui.stop();
	}
});

test("a newly mounted approval preempts the palette and receives keys instead of the old editor", async () => {
	const tui = new TUI(new VirtualTerminal(100, 30));
	const editor = new Input();
	editor.setValue("保留草稿");
	const dock = new Container();
	dock.addChild(editor);
	tui.addChild(dock);
	tui.setFocus(editor);
	tui.start();
	const controller = new AbortController();
	try {
		const result = showInkOverlay(
			tui,
			dock,
			editor,
			controller.signal,
			done => new InkPicker("操作", [{ value: "x", label: "X" }], done, () => 20),
		);
		const approval = new Input();
		let submitted = false;
		approval.onSubmit = () => {
			submitted = true;
		};
		dock.clear();
		dock.addChild(approval);
		tui.setFocus(approval);
		tui.injectDebugInput("\r");
		tui.requestRender();
		expect(await result).toBeUndefined();
		expect(tui.hasOverlay()).toBe(false);
		expect(tui.getFocused()).toBe(approval);
		expect(submitted).toBe(false);
		tui.injectDebugInput("拒绝");
		expect(approval.getValue()).toBe("拒绝");
		expect(editor.getValue()).toBe("保留草稿");
	} finally {
		controller.abort();
		tui.stop();
	}
});

test("a dialog arriving before asynchronous menu data resolves prevents a palette from opening", async () => {
	const tui = new TUI(new VirtualTerminal(100, 30));
	const editor = new Input();
	const approval = new Input();
	const dock = new Container();
	dock.addChild(approval);
	tui.setFocus(approval);
	let opened = false;
	const result = await showInkOverlay(tui, dock, editor, new AbortController().signal, () => {
		opened = true;
		return new Input();
	});
	expect(result).toBeUndefined();
	expect(opened).toBe(false);
	expect(tui.getFocused()).toBe(approval);
});

test("tall terminal picker keeps its last selected item inside the actual overlay cap", () => {
	const tui = new TUI(new VirtualTerminal(100, 80));
	const picker = new InkPicker(
		"会话",
		Array.from({ length: 100 }, (_, i) => ({ value: String(i), label: `会话-${i}` })),
		() => {},
		() => inkPickerHeight(tui.terminal.rows),
	);
	for (let i = 0; i < 99; i++) picker.handleInput("\x1b[B");
	const rows = picker.render(90).slice(0, 72);
	expect(rows.some(row => Bun.stripANSI(row).includes("› 会话-99"))).toBe(true);
	expect(rows.at(-1)).toContain("100/100");
});
