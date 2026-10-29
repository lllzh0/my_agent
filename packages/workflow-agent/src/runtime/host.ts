import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { ProductReview } from "../review/runner";
import { ProductModels, type ModelBinding } from "../models/controller";
import { loadConfig } from "../config/config";
import { Policy, contained, filterManagedSkillRoots, type Approver, type ApprovalMode } from "../policy/policy";
import { createReviewer } from "../policy/reviewer";
import { atomicJson, readJson, record } from "../storage";
import { loadResources } from "./resources";
import { LiveResources } from "./live-resources";
import type { RunState } from "./state";
import { productTools } from "./tools";
import { productExtension } from "../tui/extension";
import { startDemo } from "./demo";
import { closeSessionRuntime, openSessionRuntime, sessionStateDirectory } from "./session-state";
import { ProductSessions, type ResumeUI } from "./sessions";
import { logger } from "@oh-my-pi/pi-utils";
import { ModelTraces } from "../diagnostics/model-trace";
import { resolvePreset, samePreset } from "../presets/presets";
import { PRODUCT_TOOL_NAMES } from "./tool-catalog";
import { readSessionSnapshot } from "./session-snapshot";
import { PreparedTranscript } from "../presets/prepared-transcript";

export interface HostOptions {
	home: string;
	cwd: string;
	demo?: boolean;
	light?: boolean;
	interactive?: boolean;
	resume?: string;
	approve?: Approver;
	permissions?: ApprovalMode;
	preset?: string;
	plan?: boolean;
	onAllocated?: (id: string, file: string) => void;
	prepared?: boolean;
}
export interface Host extends CreateAgentSessionResult {
	state: RunState;
	closed: Promise<void>;
	setResumeUI(handler: ResumeUI | undefined): void;
	activate(): Promise<void>;
	dispose(): Promise<void>;
}

export async function openHost(options: HostOptions): Promise<Host> {
	await fs.mkdir(options.home, { recursive: true, mode: 0o700 });
	const home = await fs.realpath(options.home);
	const cwd = await fs.realpath(options.cwd);
	if (options.preset && options.light) throw new Error("--preset 与 --light 不能同时使用");
	const base = await loadConfig(home);
	const preset =
		options.preset && options.preset !== "legacy" ? await resolvePreset(home, cwd, options.preset, base) : undefined;
	const config = preset?.config ?? base;
	const light = preset?.light ?? options.light === true;
	if (config.model.authPath)
		throw new Error("本入口暂只使用密钥环境变量，不直接导入旧 Pi 凭据文件；请移除 model.authPath。");
	const resources = await loadResources(config, cwd, light);
	const agentDir = preset?.agentDir ?? path.join(home, "omp/agent");
	const sessionDir = preset?.sessionDir ?? path.join(home, "sessions");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(sessionDir, { recursive: true });
	const resumeFile = options.resume ? await fs.realpath(options.resume) : undefined;
	if (resumeFile && !contained(await fs.realpath(sessionDir), resumeFile))
		throw new Error("只能恢复当前产品配置目录内的会话");
	const preparedTranscript =
		options.prepared && resumeFile
			? new PreparedTranscript(resumeFile, await Bun.file(resumeFile).bytes())
			: undefined;
	const manager = resumeFile
		? await SessionManager.open(resumeFile, sessionDir, preparedTranscript?.storage, { throwIfMissing: true })
		: SessionManager.create(cwd, sessionDir);
	try {
		manager.requireExclusiveWriter();
		if (!options.resume && manager.getSessionFile())
			options.onAllocated?.(manager.getSessionId(), manager.getSessionFile()!);
		if ((await fs.realpath(manager.getCwd())) !== cwd) {
			throw new Error("恢复会话的工作区不一致");
		}
		const stateDir = sessionStateDirectory(home, manager.getSessionId());
		const previous = await readJson(path.join(stateDir, "manifest.json"));
		if (
			options.resume &&
			(!previous ||
				!samePreset(record(previous, "会话记录").preset, preset?.identity) ||
				record(previous, "会话记录").signature !== resources.signature ||
				record(previous, "会话记录").cwd !== cwd)
		) {
			throw new Error("恢复配置与旧会话不一致；请使用原配置或新开会话。");
		}
		await fs.mkdir(stateDir, { recursive: true });
		const policy = new Policy(cwd, structuredClone(config.permissions));
		policy.protectedRoots = [home];
		policy.setApprover(options.approve ?? (async () => "deny"));
		policy.setApprovalMode(options.permissions ?? config.permissions.approval ?? "manual");
		for (const input of [...config.resources.instructions, ...config.resources.skills])
			if (!light) policy.settings.readRoots.push(path.resolve(cwd, input));
		policy.settings.readRoots.push(...resources.skills.map(skill => skill.baseDir));
		policy.managedSkillReadRoots.push(
			...filterManagedSkillRoots(
				home,
				resources.skills.map(skill => skill.baseDir),
			),
		);
		let activeRuntime = await openSessionRuntime(home, cwd, manager.getSessionId(), config, light, policy);
		const state: RunState = {
			home,
			cwd,
			stateDir,
			sessionId: manager.getSessionId(),
			light,
			preset: preset?.identity,
			sessionDirectory: sessionDir,
			config,
			resources,
			policy,
			sandbox: activeRuntime.sandbox,
			jobs: activeRuntime.jobs,
			mcp: activeRuntime.mcp,
			journal: activeRuntime.journal,
			research: activeRuntime.research,
			workflow: activeRuntime.workflow,
			turn: "initial",
			snapshotWritable: false,
		};
		const closed = Promise.withResolvers<void>();
		state.traces = new ModelTraces(() => state);
		let models: ProductModels | undefined;
		const demo = options.demo ? startDemo() : undefined;
		let created: CreateAgentSessionResult | undefined;
		let sessions: ProductSessions | undefined;
		try {
			const settings = await Settings.init({
				cwd: agentDir,
				agentDir,
				inMemory: true,
				discoverProjectSettings: false,
				overrides: {
					"tools.approvalMode": "always-ask",
					"tools.xdev": false,
					"compaction.enabled": !demo,
					"retry.enabled": !demo,
					"secrets.enabled": false,
					"autolearn.enabled": false,
					"memory.backend": "off",
					"lsp.enabled": false,
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnEdit": false,
					"edit.mode": "replace",
					"startup.quiet": true,
					// Built-in message metrics reuse OMP timing, rendering and persisted history.
					"display.showTokenUsage": true,
					"input.bareSlashCommands": false,
					"task.completionProbe": false,
					"goal.enabled": !light,
				},
			});
			models = new ProductModels(state, settings, demo?.port);
			state.models = models;
			settings.setModelRole("default", `${models.activeModel().provider}/${models.activeModel().id}`);
			const bindReviewer = (binding: ModelBinding) =>
				createReviewer(binding.model, binding.apiKey, state.sessionId, policy);
			policy.setReviewer(bindReviewer(models.rootBinding()));
			const toolContext: ToolSession = {
				cwd,
				hasUI: false,
				settings,
				getSessionFile: () => manager.getSessionFile() ?? null,
				getSessionSpawns: () => null,
				enableLsp: false,
				enableMCP: false,
				getActiveModel: () => models!.activeModel(),
				hasEditTool: true,
			};
			const tools = light ? [] : productTools(state, toolContext);
			if (
				!light &&
				(tools.length !== PRODUCT_TOOL_NAMES.length - 1 ||
					new Set(tools.map(tool => tool.name)).size !== tools.length ||
					tools.some(
						tool => !(PRODUCT_TOOL_NAMES as readonly string[]).includes(tool.name) || tool.name === "goal",
					))
			)
				throw new Error("产品工具注册与预设能力清单不一致，请检查工具目录。");
			// Product tools make their own per-request authorization decisions. OMP
			// admits only these wrappers; unknown tools retain always-ask behavior.
			cfgToolsApproval.override(
				settings,
				Object.fromEntries([...tools.map(tool => [tool.name, "allow"]), ...(!light ? [["goal", "allow"]] : [])]),
			);
			created = await createAgentSession({
				decorateModelStream: state.traces.decorate,
				cwd,
				agentDir,
				settings,
				model: models.activeModel(),
				authStorage: models.auth,
				modelRegistry: models.registry,
				getApiKey: models.getApiKey,
				sessionManager: manager,
				cacheWarming: false,
				systemPrompt: () => state.resources.systemPrompt,
				// Product instructions are rendered in the prompt above. Keep native
				// context discovery closed instead of retaining a stale second copy.
				contextFiles: [],
				skills: resources.skills,
				rules: [],
				workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				preloadedCustomToolPaths: [],
				disableExtensionDiscovery: true,
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				allowRestrictedGoalTool: !light,
				toolNames: tools.map(tool => tool.name),
				// OMP 18.10.3 treats unmarked definitions as legacy CustomTool
				// callbacks, whose cancellation and update arguments have a different order.
				customTools: tools.map(tool => ({ ...tool, __isToolDefinition: true })),
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				skipPythonPreflight: true,
				requireYieldTool: false,
				preloadedPreparedExtensions: [
					{
						path: "<my-agent>",
						resolvedPath: "<my-agent>",
						error: null,
						factory: productExtension(
							state,
							options.approve,
							async () => {
								closed.resolve();
							},
							() => created?.session,
							target => sessions?.permitsNativeSwitch(target) ?? false,
						),
					},
				],
			});
			const session = created.session;
			state.liveResources = new LiveResources(state, session, [
				...tools.map(tool => tool.name),
				...(!light ? ["goal"] : []),
			]);
			await state.liveResources.syncTools();
			session.addDisposer(session.agent.addBeforeModelCallHook(() => state.liveResources!.syncTools()));
			sessions = new ProductSessions(state, created.session, async next => {
				const previousRuntime = activeRuntime;
				activeRuntime = next;
				const { diagnostics: _diagnostics, ...fields } = next;
				Object.assign(state, fields, { turn: "initial" });
				models!.rebindReviewer();
				try {
					await closeSessionRuntime(previousRuntime);
				} catch (error) {
					logger.warn("Previous product session cleanup failed", { error: String(error) });
				}
			});
			state.sessions = sessions;
			models.attach(session, bindReviewer);
			state.review = new ProductReview(state, session);
			const snapshot = options.resume && preset ? readSessionSnapshot(previous) : undefined;
			if (snapshot) await models.select(snapshot.model.model, snapshot.model.effort);
			if (snapshot?.plan || options.plan) state.policy.mode = "plan";
			created.session.setSubmissionGuard(() => {
				if (options.prepared && state.snapshotWritable === false)
					throw new Error("预设尚未激活，不能提交模型请求。");
				sessions!.assertSubmissionAllowed();
				models!.assertSubmissionAllowed();
				state.review!.assertSubmissionAllowed();
				state.liveResources!.assertSubmissionAllowed();
			});
			if (created.session.extensionRunner) created.session.extensionRunner.inputFailurePolicy = "handled";
			const streamBuffer = created.session.rawSseDebugBuffer;
			created.session.subscribe(event => {
				if (
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === "goal-continuation"
				) {
					// A cold resume through OMP's human menu has no task context yet.
					// Seed it from the active goal without replacing newer human limits.
					const goal = created?.session.getGoalModeState();
					if (goal?.enabled && !state.policy.userTask.trim()) state.policy.setUserTask(goal.goal.objective);
				}
				if (event.type === "message_start" && event.message.role === "user") {
					const text =
						typeof event.message.content === "string"
							? event.message.content
							: event.message.content
									.filter(item => item.type === "text")
									.map(item => item.text)
									.join("\n");
					if (text.trim() && !event.message.synthetic) {
						state.policy.setUserTask(text);
					}
				}
				if (event.type === "tool_execution_end" && event.isError)
					activeRuntime.diagnostics.record("tool", event.result);
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					["error", "aborted"].includes(event.message.stopReason)
				) {
					activeRuntime.diagnostics.record("model", event.message.errorMessage ?? "操作已取消");
					activeRuntime.diagnostics.recordModelStream(event.message, streamBuffer.snapshot());
				}
			});
			if (!(options.prepared && options.resume))
				await atomicJson(path.join(stateDir, "manifest.json"), {
					...(snapshot ? { runtime: snapshot } : {}),
					...(state.preset ? { preset: state.preset } : {}),
					signature: resources.signature,
					cwd,
					sessionId: state.sessionId,
					resources: resources.entries,
					tools: created.session.getActiveToolNames(),
				});
			if (!options.interactive)
				await initializeExtensions(created.session, {
					reportSendError: (_action, error) => {
						throw error;
					},
					reportRuntimeError: error => {
						throw new Error(error.error);
					},
				});
			// Product records exist before the first chat turn, so their owning session must too.
			await session.sessionManager.ensureOnDisk();
			state.snapshotWritable = !options.prepared;
			let disposing: Promise<void> | undefined;
			return {
				...created,
				state,
				closed: closed.promise,
				setResumeUI: handler => sessions!.setUI(handler),
				async activate() {
					await preparedTranscript?.activate(manager);
				},
				dispose() {
					disposing ??= (async () => {
						try {
							await state.liveResources?.close();
							await state.review?.close();
							await sessions!.close();
							await session.dispose();
						} finally {
							try {
								await closeSessionRuntime(activeRuntime);
							} finally {
								await models?.dispose();
								await state.traces?.close();
								demo?.stop(true);
								closed.resolve();
							}
						}
					})();
					return disposing;
				},
			};
		} catch (error) {
			try {
				await state.review?.close();
				await created?.session.dispose();
			} finally {
				try {
					await closeSessionRuntime(activeRuntime);
				} finally {
					await models?.dispose();
					await state.traces?.close();
					demo?.stop(true);
				}
			}
			throw error;
		}
	} catch (error) {
		await manager.close();
		throw error;
	}
}
