import { beforeAll, expect, test } from "bun:test";
import { TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { InkPicker } from "../src/tui/ink-picker";
import { InkLayout } from "../src/tui/ink-layout";
import { SessionDrafts } from "../src/tui/session-drafts";

beforeAll(() => initTheme());

test("picker filters by description, clamps selection after search and cancels without choosing", () => {
	const selected: (string | undefined)[] = [];
	const picker = new InkPicker(
		"操作",
		[
			{ value: "model", label: "模型", description: "连接设置" },
			{ value: "diff", label: "差异", description: "文件修改" },
		],
		value => selected.push(value),
		() => 14,
	);
	picker.handleInput("\x1b[B");
	picker.handleInput("连接");
	picker.handleInput("\r");
	expect(selected).toEqual(["model"]);
	picker.handleInput("不存在");
	picker.handleInput("\r");
	expect(selected).toEqual(["model"]);
	picker.handleInput("\x1b");
	expect(selected).toEqual(["model", undefined]);
});

test("picker keeps keyboard selection visible in a short terminal and bounds Chinese labels", () => {
	const picker = new InkPicker(
		"技能",
		Array.from({ length: 20 }, (_, n) => ({ value: String(n), label: `技能-${n}很长的中文名称` })),
		() => {},
		() => 12,
	);
	for (let n = 0; n < 19; n++) picker.handleInput("\x1b[B");
	const rows = picker.render(24);
	expect(rows.some(row => Bun.stripANSI(row).includes("技能-19"))).toBe(true);
	expect(rows.every(row => visibleWidth(row) <= 24)).toBe(true);
	expect(rows.length).toBeLessThanOrEqual(12);
});

test("workspace layout hides the rail at narrow widths and strips control codes from status data", () => {
	const layout = new InkLayout(() => ({
		workspace: "项目\n坏标题\x1b[31m",
		session: "讨论",
		model: "demo",
		status: "就绪",
		permission: "手动",
		trace: false,
		sessions: ["旧会话"],
		skills: ["brainstorming"],
		tools: 7,
		queued: 0,
	}));
	for (const columns of [120, 80, 32]) {
		const viewport = { columns, rows: 24 };
		const insets = layout.measure(viewport);
		const result = layout.render(viewport, ["正文"], insets);
		expect(result.every(row => visibleWidth(row) <= columns && !row.includes("\n"))).toBe(true);
		expect(result.join("\n")).not.toContain("\x1b[31m");
		expect(result.join("\n").includes("brainstorming")).toBe(columns >= 100);
	}
});

test("session drafts restore text, pasted atoms and images after switching, including committed UI failures", async () => {
	const tui = new TUI(new VirtualTerminal());
	const editor = new CustomEditor(tui);
	let session = "a";
	const drafts = new SessionDrafts(
		() => editor,
		() => session,
		tui,
	);
	editor.insertAtom("[Text #1]", "一段较长的草稿内容");
	editor.pendingImages = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
	await drafts.switch(async () => {
		session = "b";
		editor.clearDraft();
	});
	expect(editor.getText()).toBe("");
	expect(editor.pendingImages).toHaveLength(0);
	editor.setText("B 的草稿");
	await expect(
		drafts.switch(async () => {
			session = "a";
			editor.clearDraft();
			throw new Error("refresh failed");
		}),
	).rejects.toThrow("refresh failed");
	expect(editor.getExpandedText()).toContain("一段较长的草稿内容");
	expect(editor.pendingImages[0]?.data).toBe("aGVsbG8=");
	await expect(
		drafts.switch(async () => {
			editor.clearDraft();
			throw new Error("not switched");
		}),
	).rejects.toThrow("not switched");
	expect(editor.getExpandedText()).toContain("一段较长的草稿内容");
	await drafts.switch(async () => {
		session = "b";
		editor.clearDraft();
	});
	expect(editor.getText()).toBe("B 的草稿");
});

test("session transition does not display keys that a later draft restore would erase", async () => {
	const tui = new TUI(new VirtualTerminal());
	const editor = new CustomEditor(tui);
	tui.setFocus(editor);
	editor.setText("原草稿");
	const reported: boolean[] = [];
	const drafts = new SessionDrafts(
		() => editor,
		() => "a",
		tui,
		discarded => reported.push(discarded),
	);
	const pause = Promise.withResolvers<void>();
	const switching = drafts.switch(() => pause.promise);
	tui.injectDebugInput("切换中新增内容");
	expect(editor.getText()).toBe("原草稿");
	pause.resolve();
	await switching;
	expect(reported).toEqual([true]);
	tui.injectDebugInput("已就绪");
	expect(editor.getText()).toBe("原草稿已就绪");
});
