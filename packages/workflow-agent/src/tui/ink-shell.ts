import * as path from "node:path";
import type { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgComposerShape, cfgStatusLinePreset } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { matchesKey, Text, type Component } from "@oh-my-pi/pi-tui";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { RunState } from "../runtime/state";
import { collectProductDiff } from "../review/diff";
import { permissionLabel } from "./permissions";
import { InkLayout } from "./ink-layout";
import { InkPicker, type InkChoice } from "./ink-picker";
import { InkDocument } from "./ink-document";
import { inkPickerHeight, showInkOverlay } from "./ink-overlay";

/** Product navigation over the existing session and permission controllers. */
export class InkShell {
	readonly #lifetime = new AbortController();
	readonly #layout: InkLayout;
	#sessions: SessionInfo[] = [];
	#removeInput?: () => void;
	#busy = false;
	#disposed = false;
	constructor(
		readonly mode: InteractiveMode,
		readonly state: RunState,
	) {
		this.#layout = new InkLayout(() => ({
			workspace: `${path.basename(state.cwd)}${state.preset ? ` · ${state.preset.id}` : ""}`,
			session: mode.sessionName ?? state.sessionId.slice(0, 8),
			model: mode.session.model?.name ?? "模型未连接",
			status: state.sessions?.busy
				? "切换会话"
				: mode.session.isCompacting
					? "整理上下文"
					: mode.session.isStreaming
						? "执行中 · Esc 停止"
						: "就绪",
			permission: `${state.policy.mode === "plan" ? "计划 · " : ""}${permissionLabel(state.policy.approvalMode)}`,
			trace: state.traces?.enabled === true,
			sessions: this.#sessions.map(info => info.title || info.firstMessage || info.id.slice(0, 8)),
			skills: (state.skillAccess?.effectiveSkills() ?? state.resources.skills).map(skill => skill.name),
			tools: mode.session.getActiveToolNames().length,
			queued: mode.session.queuedMessageCount,
		}));
	}
	async start(): Promise<void> {
		cfgComposerShape.override(this.mode.settings, "rule");
		cfgStatusLinePreset.override(this.mode.settings, "compact");
		this.mode.syncComposerShape();
		this.mode.editor.placeholder = () => "输入任务 · / 命令 · $ 技能";
		this.mode.editor.setPromptGutter("› ");
		this.mode.composer.setPreferences({ quiet: true });
		this.mode.composer.setHeaderExtras(
			[new Text("从一个任务开始\n描述要修改的代码或需要研究的问题。\n\nCtrl+P 查看操作 · $ 选择技能", 1, 1)],
			[],
		);
		if (!isNativeRendering()) this.mode.composer.setFrameDecoration(this.#layout);
		this.mode.hookWidgetContainerBelow.addChild(new Text("Ctrl+P 操作  F2 会话  F3 资源  / 命令  $ 技能", 0, 0));
		this.mode.setToolsExpanded(false);
		this.#removeInput = this.mode.ui.addInputListener(data => {
			// Never steal keys from an approval dialog, completion overlay or another editor.
			if (
				this.#busy ||
				this.state.sessions?.busy ||
				this.mode.ui.hasOverlay() ||
				this.mode.ui.getFocused() !== this.mode.editor
			)
				return;
			const action = matchesKey(data, "ctrl+p")
				? "palette"
				: matchesKey(data, "f2")
					? "sessions"
					: matchesKey(data, "f3")
						? "resources"
						: undefined;
			if (!action) return;
			void this.#run(action);
			return { consume: true };
		});
		await this.refreshSessions();
	}
	async refreshSessions(): Promise<void> {
		try {
			this.#sessions = ((await this.state.sessions?.list()) ?? []).sort(
				(a, b) => b.modified.getTime() - a.modified.getTime(),
			);
		} catch (error) {
			if (!this.#disposed)
				this.mode.showWarning(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`);
		}
		if (!this.#disposed) this.mode.ui.requestRender();
	}
	dispose(): void {
		this.#disposed = true;
		this.#lifetime.abort();
		this.#removeInput?.();
	}
	#overlay<T>(
		factory: (done: (value: T | undefined) => void) => Component,
		fullscreen = false,
	): Promise<T | undefined> {
		return showInkOverlay(
			this.mode.ui,
			this.mode.editorContainer,
			this.mode.editor,
			this.#lifetime.signal,
			factory,
			fullscreen,
		);
	}

	#choose(title: string, items: readonly InkChoice[]): Promise<string | undefined> {
		return this.#overlay<string | undefined>(
			done => new InkPicker(title, items, done, () => inkPickerHeight(this.mode.ui.terminal.rows)),
		);
	}
	async #document(title: string, body: string): Promise<void> {
		await this.#overlay(
			done =>
				new InkDocument(
					title,
					body,
					() => Math.max(5, this.mode.ui.terminal.rows - 2),
					() => done(undefined),
				),
			true,
		);
	}
	async #dispatch(command: string): Promise<void> {
		// Exactly the interactive input hook used by typed commands; never fall back to a model prompt.
		const result = await this.mode.session.extensionRunner?.emitInput(command, undefined, "interactive");
		if (!result?.handled) throw new Error("此操作尚未接入产品命令，请返回输入区操作。");
	}
	async #run(initial: string): Promise<void> {
		this.#busy = true;
		try {
			let action: string | undefined = initial;
			if (action === "palette")
				action = await this.#choose("操作面板", [
					{ value: "sessions", label: "会话", description: "切换 / 新建 · F2" },
					{ value: "skills", label: "调用技能", description: "$brainstorming 等已启用技能" },
					{ value: "resources", label: "资源与工具", description: "选择 / 导入外部技能 · F3" },
					{ value: "diff", label: "文件差异", description: "查看工作区实际修改" },
					{ value: "sources", label: "研究来源", description: "区分摘要与已取得正文" },
					{
						value: "execution",
						label: this.mode.toolOutputExpanded ? "折叠执行记录" : "展开执行记录",
						description: "Ctrl+O",
					},
					{ value: "trace", label: "模型请求轨迹", description: "查看 / 对比本地记录" },
					{ value: "model", label: "模型连接", description: "选择已配置模型" },
					{
						value: "permissions",
						label: "授权方式",
						description: permissionLabel(this.state.policy.approvalMode),
					},
					{ value: "plan", label: "切换计划 / 执行", description: "计划模式只读" },
					{ value: "sidebar", label: this.#layout.sidebar ? "收起侧栏" : "展开侧栏" },
					{ value: "stop", label: "停止当前回答", description: "保留聊天 · Esc" },
				]);
			if (!action || this.#disposed) return;
			switch (action) {
				case "sessions": {
					await this.refreshSessions();
					const id = await this.#choose("会话 · 当前工作区", [
						{ value: "new", label: "+ 新建会话", description: "保存当前聊天与草稿" },
						...this.#sessions.map(info => ({
							value: info.id,
							label: info.title || info.firstMessage || info.id.slice(0, 8),
							description: `${info.messageCount} 条消息 · ${info.modified.toLocaleDateString()}`,
						})),
					]);
					if (id) await this.#dispatch(id === "new" ? "/new" : `/resume ${id}`);
					await this.refreshSessions();
					break;
				}
				case "skills": {
					const skill = await this.#choose(
						"技能 · 选择后填入输入框",
						(this.state.skillAccess?.effectiveSkills() ?? this.state.resources.skills).map(item => ({
							value: item.name,
							label: `$${item.name}`,
							description: item.description,
						})),
					);
					if (skill) {
						const draft = this.mode.editor.getExpandedText().replace(/^\$[^\s]*\s*/, "");
						this.mode.editor.setCollapsedText(`$${skill} ${draft}`);
					}
					break;
				}
				case "diff": {
					const diff = await collectProductDiff(this.state, undefined, this.#lifetime.signal);
					await this.#document(
						"文件差异 · 只读",
						[
							diff.note,
							`${diff.files.length} 个文件 · ${diff.complete ? "本次采集完整" : "存在省略"}`,
							...diff.excluded.map(item => `省略 ${item.path}: ${item.reason}`),
							"",
							diff.patch || "没有可显示的文本差异。",
						].join("\n"),
					);
					break;
				}
				case "sources": {
					const sources = this.state.research.sources;
					if (!sources.length) {
						await this.#document("研究来源", "当前会话尚无来源记录。");
						break;
					}
					const id = await this.#choose(
						"研究来源",
						sources.map(source => ({
							value: source.id,
							label: source.title,
							description: source.coverage.acquisition === "search" ? "搜索摘要" : "已取得内容 · 查看范围",
						})),
					);
					const source = sources.find(item => item.id === id);
					if (source)
						await this.#document(
							source.title,
							[
								source.url ?? source.path ?? source.id,
								`获取方式：${source.coverage.acquisition}`,
								`已提取 ${source.coverage.extractedChars} 字符；总量 ${source.coverage.totalChars ?? "未知"}`,
								`提取截断：${String(source.coverage.extractionTruncated)}；这里只预览前 6000 字符，不代表模型读完全文。`,
								"",
								source.text.slice(0, 6000),
							].join("\n"),
						);
					break;
				}
				case "execution":
					this.mode.setToolsExpanded(!this.mode.toolOutputExpanded);
					break;
				case "sidebar":
					this.#layout.sidebar = !this.#layout.sidebar;
					break;
				case "stop":
					// Use the same queue recovery and user-interrupt reason as Esc.
					// A bare session abort leaves queued input eligible for automatic delivery.
					if (this.mode.session.isStreaming || this.mode.session.isCompacting || this.mode.session.isRetrying)
						this.mode.editor.onEscape?.();
					break;
				default:
					await this.#dispatch(`/${action}`);
			}
		} catch (error) {
			if (!this.#disposed) this.mode.showError(error instanceof Error ? error.message : String(error));
		} finally {
			this.#busy = false;
			if (!this.#disposed) this.mode.ui.requestRender();
		}
	}
}
