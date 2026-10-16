import { openHost } from "../src/runtime/host";
import { cfgShellPath } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { productTools } from "../src/runtime/tools";
import * as fs from "node:fs/promises";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { testSetExtensionHandlerTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/sdk";

const options = JSON.parse(process.argv[2]) as {
	home: string;
	cwd: string;
	resultFile: string;
	light?: boolean;
	approve?: boolean | "connect";
	plan?: boolean;
	planOnApproval?: "connect" | "call";
	resume?: string;
	action?: string;
	command?: string;
	commands?: string[];
	promptAfterCommands?: string;
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
		const ui = host.session.extensionRunner!.getUIContext();
		ui.editor = async (title, text) => {
			displays.push({ title, text: text ?? "" });
			return undefined;
		};
		ui.notify = message => {
			notifications.push(message);
		};
		let actionResult: unknown;
		if (options.action === "user-bash")
			actionResult = await host.session.executeBash(options.command ?? "printf unsafe");
		else if (options.action === "user-python")
			actionResult = await host.session.executePython(options.command ?? "print('unsafe')");
		else if (options.action === "new-session") actionResult = await host.session.newSession();
		else if (options.action === "input")
			actionResult = await host.session.extensionRunner?.emitInput(
				options.command ?? "/agent",
				undefined,
				"interactive",
			);
		else if (options.action === "commands") {
			actionResult = [];
			for (const command of options.commands ?? [])
				(actionResult as unknown[]).push(
					await host.session.extensionRunner!.emitInput(command, undefined, "interactive"),
				);
			await host.session.waitForIdle();
			if (options.promptAfterCommands) await host.session.prompt(options.promptAfterCommands);
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
		else if (options.action === "hold-session") {
			await host.session.prompt("LEASE_OWNER");
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
			await host.dispose();
			actionResult = await pending;
			pendingApproval.resolve("deny");
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
				changes: host.state.journal.list(),
				jobs: host.state.jobs.list(),
				resources: host.state.resources.entries,
				shellPath: cfgShellPath.get(host.session.settings) ?? null,
				modelName: host.session.model?.name,
				mcp: host.state.mcp.status(),
				actionResult,
				displays,
				notifications,
				thinking: host.session.configuredThinkingLevel(),
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
