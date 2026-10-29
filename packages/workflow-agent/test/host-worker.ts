import { openHost } from "../src/runtime/host";
import { cfgShellPath } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { productTools } from "../src/runtime/tools";
import * as fs from "node:fs/promises";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { testSetExtensionHandlerTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { Change } from "../src/changes/journal";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { resourceScenario } from "./resource-scenarios";
import { traceScenario } from "./trace-scenarios";

const options = JSON.parse(process.argv[2]) as {
	home: string;
	cwd: string;
	resultFile: string;
	preset?: string;
	prepared?: boolean;
	light?: boolean;
	approve?: boolean | "connect";
	approveTool?: "once" | "run";
	plan?: boolean;
	planOnApproval?: "connect" | "call";
	resume?: string;
	action?: string;
	modelScenario?: "pre" | "post" | "rollback" | "transition";
	newScenario?: "switch-failure" | "post-switch-failure" | "cancelled" | "late-cancelled" | "guarded";
	inputSource?: "interactive" | "extension";
	command?: string;
	commands?: string[];
	promptAfterCommands?: string;
	promptsBefore?: string[];
	resumeSelection?: string;
	resumeScenario?:
		| "busy"
		| "switch-failure"
		| "post-switch-failure"
		| "input-during-switch"
		| "retry-key-during-switch";
	undoScenario?:
		| "normal"
		| "conflict"
		| "plan-after-approval"
		| "queued-plan"
		| "pending-job"
		| "late-plan"
		| "slow-ui";
};
try {
	if (options.action === "failed-open-stays") {
		try {
			await openHost({ home: options.home, cwd: options.cwd, resume: options.resume });
			throw new Error("expected initialization failure");
		} catch (error) {
			await Bun.write(`${options.home}/failure-ready`, String(error));
		}
		while (!(await Bun.file(`${options.home}/failure-release`).exists())) await Bun.sleep(10);
		process.exit(0);
	}
	let switchToPlan = () => {};
	const approvalStarted = Promise.withResolvers<void>();
	const pendingApproval = Promise.withResolvers<"deny">();
	const host = await openHost({
		...options,
		approveTool: options.approveTool ? async () => options.approveTool! : undefined,
		approve: options.approve
			? async request => {
					if (options.planOnApproval && request.tool.startsWith(`mcp-${options.planOnApproval}:`)) switchToPlan();
					if (options.action === "mcp-close-pending" && request.tool.startsWith("mcp-call:")) {
						approvalStarted.resolve();
						return pendingApproval.promise;
					}
					return options.approve === "connect" && !request.tool.startsWith("mcp-connect:") ? "deny" : "once";
				}
			: undefined,
	});
	switchToPlan = () => {
		host.state.policy.mode = "plan";
	};
	try {
		if (options.plan) host.state.policy.mode = "plan";
		const displays: { title: string; text: string }[] = [];
		const notifications: string[] = [];
		let resumePickerShown = 0;
		const ui = host.session.extensionRunner!.getUIContext();
		ui.editor = async (title, text) => {
			displays.push({ title, text: text ?? "" });
			return undefined;
		};
		ui.notify = message => {
			notifications.push(message);
		};
		if (options.resumeSelection) {
			const interactiveUI: ExtensionUIContext = Object.create(ui);
			interactiveUI.custom = async <T>() => {
				resumePickerShown++;
				return (options.resumeSelection === "cancel" ? undefined : options.resumeSelection) as T;
			};
			await initializeExtensions(host.session, {
				uiContext: interactiveUI,
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: error => {
					throw new Error(error.error);
				},
			});
		}
		let actionResult: unknown;
		const resumeChecks: string[] = [];
		let closedChanges: Change[] | undefined;
		for (const text of options.promptsBefore ?? []) await host.session.prompt(text);
		if (options.action?.startsWith("trace-")) {
			actionResult = await traceScenario(host, options.action.slice(6));
		} else if (options.action === "product-new") {
			const source = { id: host.state.sessionId, file: host.session.sessionFile, stateDir: host.state.stateDir };
			const checks: string[] = [];
			const newController = new AbortController();
			if (options.newScenario === "switch-failure")
				host.setResumeUI(async () => {
					throw new Error("fixture-new-switch-failed");
				});
			else if (options.newScenario === "late-cancelled")
				host.setResumeUI(async target => {
					await Bun.sleep(5);
					newController.abort();
					await host.session.switchSession(target, { keepModel: true });
				});
			else if (options.newScenario === "post-switch-failure")
				host.setResumeUI(async target => {
					await host.session.switchSession(target, { keepModel: true });
					throw new Error("fixture-new-refresh-failed");
				});
			else if (options.newScenario === "guarded")
				host.setResumeUI(async target => {
					for (const operation of [
						() => host.session.prompt("MUST_NOT_RUN_DURING_NEW"),
						() => host.session.retry(),
						() => host.session.steer("MUST_NOT_RUN_DURING_NEW"),
						() => host.session.followUp("MUST_NOT_RUN_DURING_NEW"),
						() => host.session.sendUserMessage("MUST_NOT_RUN_DURING_NEW", { deliverAs: "followUp" }),
						() => host.state.sessions!.startNew(),
					]) {
						try {
							await operation();
							checks.push("admitted");
						} catch {
							checks.push("blocked");
						}
					}
					await host.session.switchSession(target, { keepModel: true });
				});
			let error = "";
			let result: unknown;
			try {
				result = await host.state.sessions!.startNew(
					options.newScenario === "cancelled" ? AbortSignal.abort() : newController.signal,
				);
			} catch (failure) {
				error = String(failure);
			}
			actionResult = {
				source,
				result,
				error,
				checks,
				sessions: await host.state.sessions!.list(),
				busy: host.state.sessions!.busy,
			};
			if (options.promptAfterCommands) await host.session.prompt(options.promptAfterCommands);
		} else if (options.action === "models") {
			const models = host.state.models!;
			const native = host.session.setModel.bind(host.session);
			const previousModel = host.session.model!;
			const previousEffort = host.session.configuredThinkingLevel();
			const previousRevision = host.state.policy.revision;
			let attempts = 0;
			const checks: string[] = [];
			host.session.setModel = async (model, role, switchOptions) => {
				attempts++;
				if (attempts === 1 && options.modelScenario === "pre") throw new Error("fixture-before-change");
				if (options.modelScenario === "rollback" && attempts > 1) throw new Error("fixture-rollback-failure");
				if (attempts === 1 && options.modelScenario === "transition") {
					for (const operation of [
						() => host.session.prompt("MUST_NOT_SUBMIT"),
						() => host.session.retry(),
						() => host.session.steer("MUST_NOT_SUBMIT"),
						() => host.session.followUp("MUST_NOT_SUBMIT"),
						() => host.session.sendUserMessage("MUST_NOT_SUBMIT", { deliverAs: "followUp" }),
						() => models.select("second"),
						() => host.state.sessions!.resume("absent.jsonl"),
					]) {
						try {
							await operation();
							checks.push("admitted");
						} catch {
							checks.push("blocked");
						}
					}
					for (const command of ["/model second", "/fresh", "/goal set forbidden", "/retry"])
						checks.push(
							(await host.session.extensionRunner!.emitInput(command, undefined, "interactive")).handled
								? "blocked"
								: "admitted",
						);
				}
				const result = await native(model, role, switchOptions);
				if (attempts === 1 && (options.modelScenario === "post" || options.modelScenario === "rollback"))
					throw new Error("fixture-after-change");
				return result;
			};
			let failure = "";
			try {
				await models.select("second");
			} catch (error) {
				failure = String(error);
			}
			let submissionBlocked = false;
			try {
				models.assertSubmissionAllowed();
			} catch {
				submissionBlocked = true;
			}
			actionResult = {
				failure,
				attempts,
				checks,
				submissionBlocked,
				key: models.current().key,
				baseUrl: host.session.model?.baseUrl,
				previousBaseUrl: previousModel.baseUrl,
				previousEffort,
				effort: host.session.configuredThinkingLevel(),
				revisionBefore: previousRevision,
				revisionAfter: host.state.policy.revision,
				credential:
					(await models.registry.getApiKey(host.session.model!)) === "fake-local-key" ? "original" : "second",
			};
			if (!submissionBlocked && options.promptAfterCommands) await host.session.prompt(options.promptAfterCommands);
		} else if (options.action === "resources") actionResult = await resourceScenario(host, options.command!);
		else if (options.action === "user-bash")
			actionResult = await host.session.executeBash(options.command ?? "printf unsafe");
		else if (options.action === "user-python")
			actionResult = await host.session.executePython(options.command ?? "print('unsafe')");
		else if (options.action === "new-session") actionResult = await host.session.newSession();
		else if (options.action === "input")
			actionResult = await host.session.extensionRunner?.emitInput(
				options.command ?? "/agent",
				undefined,
				options.inputSource ?? "interactive",
			);
		else if (options.action === "list-sessions") actionResult = await host.state.sessions!.list();
		else if (options.action === "dispose-during-resume") {
			await host.session.prompt("CURRENT_SESSION_ONLY");
			let closing: Promise<void> | undefined;
			host.setResumeUI(async target => {
				await host.session.switchSession(target, { keepModel: true });
				closing = host.dispose();
				await Bun.sleep(30);
			});
			await host.state.sessions!.resume(options.command!);
			await closing;
			await host.dispose();
			try {
				await host.state.journal.stats();
				actionResult = "open";
			} catch {
				actionResult = "closed";
			}
			closedChanges = [];
		} else if (options.action === "commands" || options.action === "submit" || options.action === "resume") {
			if (options.action === "resume") {
				await host.session.prompt("CURRENT_SESSION_ONLY");
				if (options.resumeScenario === "busy") {
					await host.session.extensionRunner!.emitInput("/permissions full", undefined, "interactive");
					await host.state.jobs.start("sleep 30");
				} else if (options.resumeScenario === "switch-failure")
					host.setResumeUI(async () => {
						host.setResumeUI(undefined);
						throw new Error("fixture native switch failed");
					});
				else if (options.resumeScenario === "post-switch-failure")
					host.setResumeUI(async target => {
						await host.session.switchSession(target, { keepModel: true });
						throw new Error("fixture post-switch render failed");
					});
				else if (options.resumeScenario === "input-during-switch")
					host.setResumeUI(async target => {
						await host.session.switchSession(target, { keepModel: true });
						for (const operation of [
							() => host.session.prompt("ATTEMPT_DURING_SWITCH"),
							() => host.session.retry(),
							() => host.session.steer("ATTEMPT_DURING_SWITCH"),
							() => host.session.followUp("ATTEMPT_DURING_SWITCH"),
							() => host.session.sendUserMessage("ATTEMPT_DURING_SWITCH", { deliverAs: "followUp" }),
						]) {
							try {
								await operation();
								resumeChecks.push("admitted");
							} catch {
								resumeChecks.push("blocked");
							}
						}
					});
				else if (options.resumeScenario === "retry-key-during-switch")
					host.setResumeUI(async target => {
						await host.session.switchSession(target, { keepModel: true });
						const controller = new InputController({
							viewSession: host.session,
							editor: {
								clearDraft() {
									resumeChecks.push("cleared");
								},
							},
							showStatus(text: string) {
								notifications.push(text);
							},
							showError(text: string) {
								notifications.push(text);
							},
						} as unknown as InteractiveModeContext);
						void controller.handleRetry();
						await Bun.sleep(30);
					});
			}
			actionResult = [];
			for (const command of options.commands ?? [])
				(actionResult as unknown[]).push(
					await host.session.extensionRunner!.emitInput(command, undefined, options.inputSource ?? "interactive"),
				);
			await host.session.waitForIdle();
			if (options.action === "submit") {
				const input = await host.session.extensionRunner!.emitInput(
					options.command ?? "",
					undefined,
					"interactive",
				);
				actionResult = input;
				if (!input.handled)
					await host.session.prompt(input.text ?? options.command ?? "", { images: input.images });
			} else if (options.promptAfterCommands) await host.session.prompt(options.promptAfterCommands);
		} else if (options.action === "undo") {
			await host.session.prompt("PRODUCT_HISTORY");
			const existing = `${options.cwd}/existing.txt`;
			const created = `${options.cwd}/created.txt`;
			await Bun.write(existing, "user original");
			await fs.chmod(existing, 0o755);
			await host.state.journal.capture("first", existing, async () => {
				await Bun.write(existing, "first turn");
			});
			await host.state.journal.capture("second", existing, async () => {
				await Bun.write(existing, "second intermediate");
			});
			await host.state.journal.capture("second", created, async () => {
				await Bun.write(created, "new file");
			});
			await host.state.journal.capture("second", existing, async () => {
				await Bun.write(existing, "second final");
			});
			if (options.undoScenario === "conflict") await Bun.write(created, "user continued editing");
			if (options.undoScenario === "late-plan") {
				const original = host.state.policy.resolvePath.bind(host.state.policy);
				let resolves = 0;
				host.state.policy.resolvePath = async (target, kind) => {
					const result = await original(target, kind);
					if (target === host.state.journal.list()[0].path && ++resolves === 3) host.state.policy.mode = "plan";
					return result;
				};
			}
			if (options.undoScenario === "slow-ui") {
				const interactiveUI: ExtensionUIContext = Object.create(ui);
				interactiveUI.editor = async (title, text) => {
					displays.push({ title, text: text ?? "" });
					await Bun.sleep(70);
					return undefined;
				};
				interactiveUI.select = async () => {
					await Bun.sleep(70);
					return "仅本次允许";
				};
				await initializeExtensions(host.session, {
					uiContext: interactiveUI,
					reportSendError: (_action, error) => {
						throw error;
					},
					reportRuntimeError: error => {
						notifications.push(error.error);
					},
				});
				testSetExtensionHandlerTimeoutMs(20);
			}
			if (options.undoScenario === "plan-after-approval")
				host.state.policy.setApprover(async () => {
					host.state.policy.mode = "plan";
					return "once";
				});
			if (options.undoScenario === "pending-job") {
				const starting = Promise.withResolvers<void>();
				const release = Promise.withResolvers<"deny">();
				host.state.policy.setApprover(async request => {
					if (request.kind === "execute") {
						starting.resolve();
						return release.promise;
					}
					return "once";
				});
				const pendingJob = host.state.jobs.start("printf must-not-run").catch(error => String(error));
				await starting.promise;
				try {
					actionResult = await host.session.extensionRunner!.emitInput("/undo", undefined, "interactive");
				} finally {
					release.resolve("deny");
					await pendingJob;
				}
			} else if (options.undoScenario === "queued-plan") {
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const approved = Promise.withResolvers<void>();
				const holding = host.state.journal.capture("hold", `${options.cwd}/hold.txt`, async () => {
					started.resolve();
					await release.promise;
				});
				await started.promise;
				host.state.policy.setApprover(async () => {
					approved.resolve();
					return "once";
				});
				const pending = host.session.extensionRunner!.emitInput("/undo", undefined, "interactive");
				try {
					await approved.promise;
					await Bun.sleep(0);
					host.state.policy.mode = "plan";
				} finally {
					release.resolve();
					await holding;
					actionResult = await pending;
				}
			} else
				actionResult = await host.session.extensionRunner!.emitInput(
					options.command ?? "/undo",
					undefined,
					"interactive",
				);
			await host.session.waitForIdle();
		} else if (options.action === "restore") await host.state.journal.restore(host.state.journal.list()[0].id);
		else if (options.action === "hold-session" || options.action === "hold-blank-session") {
			if (options.action === "hold-session") await host.session.prompt("LEASE_OWNER");
			await Bun.write(`${options.home}/owner-ready`, "ready");
			while (!(await Bun.file(`${options.home}/owner-release`).exists())) await Bun.sleep(10);
		} else if (options.action === "mcp-timed-close") {
			await host.state.mcp.list("fixture");
			const started = Date.now();
			await host.state.mcp.close();
			actionResult = { elapsed: Date.now() - started };
		} else if (options.action === "mcp-close-immediately") {
			let approvals = 0;
			host.state.policy.setApprover(async () => {
				approvals++;
				return "deny";
			});
			const pending = host.state.mcp.list("fixture").catch(error => String(error));
			await host.state.mcp.close();
			await pending;
			await Bun.sleep(10);
			actionResult = { approvals };
		} else if (options.action === "mcp-close-pending") {
			const pending = host.state.mcp
				.call("fixture", "update_record", { value: "never-send" })
				.catch(error => String(error));
			await approvalStarted.promise;
			closedChanges = host.state.journal.list();
			await host.dispose();
			actionResult = await pending;
			pendingApproval.resolve("deny");
		} else if (options.action === "revoked-files") {
			await Bun.write(options.cwd + "/existing.txt", "ORIGINAL");
			const tools = productTools(host.state, {
				cwd: host.state.cwd,
				settings: host.session.settings,
				hasUI: false,
				getSessionFile: () => host.session.sessionFile ?? null,
				getSessionSpawns: () => null,
			});
			const authorize = host.state.policy.authorize.bind(host.state.policy);
			host.state.policy.authorize = async (request, signal) => {
				await authorize(request, signal);
				host.state.policy.setApprovalMode("manual");
			};
			const context = host.session.extensionRunner!.createContext();
			actionResult = [];
			for (const [name, input] of [
				["write", { path: "created.txt", content: "FORBIDDEN" }],
				["edit", { path: "existing.txt", old_string: "ORIGINAL", new_string: "FORBIDDEN" }],
				["write_report", { path: "report.md", claims: [{ text: "An inference", sourceIds: [], inference: true }] }],
			] as const) {
				host.state.policy.setApprovalMode("full");
				try {
					await tools.find(tool => tool.name === name)!.execute("revoked", input, undefined, undefined, context);
					(actionResult as string[]).push("unexpected write");
				} catch (error) {
					(actionResult as string[]).push(String(error));
				}
			}
		} else if (options.action === "queued-files-plan") {
			const queued = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holding = host.state.journal.capture("hold", `${options.cwd}/hold.txt`, async () => {
				queued.resolve();
				await release.promise;
			});
			await queued.promise;
			const tools = productTools(host.state, {
				cwd: host.state.cwd,
				settings: host.session.settings,
				hasUI: false,
				getSessionFile: () => host.session.sessionFile ?? null,
				getSessionSpawns: () => null,
			});
			const context = host.session.extensionRunner!.createContext();
			const approvalsDone = Promise.withResolvers<void>();
			let approvals = 0;
			host.state.policy.setApprover(async () => {
				if (++approvals === 2) approvalsDone.resolve();
				return "once";
			});
			const pending = [
				tools
					.find(tool => tool.name === "write")!
					.execute("queued-write", { path: "queued.txt", content: "blocked" }, undefined, undefined, context),
				tools
					.find(tool => tool.name === "edit")!
					.execute(
						"queued-edit",
						{ path: "existing.txt", old_string: "original", new_string: "blocked" },
						undefined,
						undefined,
						context,
					),
			];
			try {
				await approvalsDone.promise;
				// After approval, callbacks only enqueue capture microtasks. Let those
				// settle while the real journal remains blocked by the holding capture.
				await Bun.sleep(0);
				host.state.policy.mode = "plan";
				release.resolve();
				actionResult = (await Promise.allSettled(pending)).map(item =>
					item.status === "rejected" ? String(item.reason) : JSON.stringify(item.value),
				);
			} finally {
				release.resolve();
				await Promise.allSettled([holding, ...pending]);
			}
		} else if (options.action === "mcp-lifecycle") {
			await host.state.mcp.list("fixture");
			await host.state.mcp.disconnect("fixture");
			await host.state.mcp.list("fixture");
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error("fixture-cancel")), 100);
			try {
				await host.state.mcp.call("fixture", "update_record", { value: "cancel" }, controller.signal);
			} catch (error) {
				actionResult = error instanceof Error ? error.message : String(error);
			} finally {
				clearTimeout(timer);
			}
		} else if (options.action === "message-metrics") {
			if (!options.resume) await host.session.prompt("MESSAGE_METRICS");
			await initTheme();
			const transcript = new ChatTranscriptBuilder({
				ui: { requestRender() {}, requestComponentRender() {} } as unknown as TUI,
				cwd: options.cwd,
				requestRender() {},
			});
			transcript.rebuild(host.session.sessionManager.getBranch().filter(entry => entry.type === "message"));
			actionResult = { rendered: Bun.stripANSI(transcript.container.render(160).join("\n")) };
		} else if (options.action === "abort-stalled-model") {
			let timer: Timer | undefined;
			const unsubscribe = host.session.subscribe(event => {
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "thinking_delta" &&
					event.assistantMessageEvent.delta === "..."
				)
					timer = setTimeout(() => void host.session.abort(), 30);
			});
			try {
				await host.session.prompt("PRODUCT_HISTORY");
			} finally {
				clearTimeout(timer);
				unsubscribe();
			}
		} else await host.session.prompt("PRODUCT_HISTORY");
		await Bun.write(
			options.resultFile,
			JSON.stringify({
				messages: host.session.messages,
				sessionFile: host.session.sessionFile,
				tools: host.session.getActiveToolNames(),
				changes: closedChanges ?? host.state.journal.list(),
				jobs: host.state.jobs.list(),
				resources: host.state.resources.entries,
				shellPath: cfgShellPath.get(host.session.settings) ?? null,
				modelName: host.session.model?.name,
				mcp: host.state.mcp.status(),
				actionResult,
				displays,
				notifications,
				thinking: host.session.configuredThinkingLevel(),
				automaticReview: host.state.policy.reviewUsage,
				userTask: host.state.policy.userTask,
				stateSessionId: host.state.sessionId,
				stateDir: host.state.stateDir,
				workflow: host.state.workflow.tasks,
				sources: closedChanges ? [] : host.state.research.sources,
				resumePickerShown,
				resumeChecks,
				availableEfforts: host.session.getAvailableEffortSelectors(),
			}),
		);
	} finally {
		await host.dispose();
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
