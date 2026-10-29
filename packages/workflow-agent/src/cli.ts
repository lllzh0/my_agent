import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { sandboxCapabilities } from "./processes/sandbox-status";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { loadConfig, saveConfig, recoverConfig } from "./config/config";
import { openHost } from "./runtime/host";
import { redact, record } from "./storage";
import { parseMcpConfig } from "./mcp/config";
import { productKeybindings, productResumeCommand } from "./tui/options";
import { parseProductCommand, productCommandCatalog } from "./tui/commands";
import { runProductInputLoop } from "./tui/input-loop";
import { initializeProductInput } from "./tui/startup-input";
import { createSkillAutocompleteProvider } from "./tui/skill-input";
import { InkShell } from "./tui/ink-shell";
import { SessionDrafts } from "./tui/session-drafts";
import { diagnosticReport, saveDiagnosticReport } from "./diagnostics/report";
import { classifyError, ModelRequestError } from "./diagnostics/errors";
import type { ApprovalMode } from "./policy/policy";
import { resolvePreset } from "./presets/presets";
import { CLI_OPTIONS } from "./cli-options";
import { HandoffConnection } from "./presets/handoff-client";
import { postmortem } from "@oh-my-pi/pi-utils";

const launcherToken = process.env.MY_AGENT_HANDOFF_TOKEN;

async function run(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: CLI_OPTIONS,
	});
	if (values.help) {
		process.stdout.write(
			"My Agent 0.2.0 · OMP\n编程与资料研究\n\n用法：bun run agent [setup|doctor|diagnose|restore-config] [选项]\n  setup --defaults       保存默认模型与搜索配置，不发送请求\n  doctor                 检查配置和运行依赖，不发送请求\n  diagnose               预览脱敏诊断 JSON，不发送请求\n  diagnose --output 文件 保存诊断到新文件，不覆盖已有文件\n  --demo                 本地模拟回答，不调用真实服务\n  --preset ID            按命名清单启动独立预设\n  preset list/create/copy/show/check/bind/unbind/default  管理预设\n  preset default --clear  清除全局默认\n  /preset                终端内创建、编辑和选择资源；下次启动生效\n  --light                不加载工作流资源和工具\n  --ui ink|classic       墨线界面（默认）或经典界面\n  --print --prompt 文本  输出一次回答；副作用默认拒绝\n  --home 路径            独立配置和会话目录\n  --cwd 路径             工作目录\n  --resume 会话文件      恢复当前配置目录内的 OMP 产品会话\n  --permissions 模式     manual 手动、auto 自动、full 完整授权；仅本次启动\n\n终端主菜单 /agent；计划模式 /agent-plan。配置修改在重启后生效。\n模型凭据：OPENCODE_API_KEY；搜索凭据：TAVILY_API_KEY。\n",
		);
		process.stdout.write(
			"预设交接：/preset use ID [--new]；/resume 可跨预设选择历史。忙碌时拒绝，准备时 Esc 取消。\n",
		);
		return;
	}
	const selectedPermissions = values.permissions;
	if (values.ui !== undefined && !["ink", "classic"].includes(values.ui))
		throw new Error("--ui 只支持 ink 或 classic");
	if (selectedPermissions !== undefined && !["manual", "auto", "full"].includes(selectedPermissions))
		throw new Error("--permissions 只支持 manual、auto 或 full");
	const permissions = selectedPermissions as ApprovalMode | undefined;
	const home = path.resolve(process.env.MY_AGENT_HOME ?? values.home ?? path.join(os.homedir(), ".my-agent-omp"));
	const cwd = path.resolve(process.env.MY_AGENT_CWD ?? values.cwd ?? process.cwd());
	if (values.preset && values.preset !== "legacy" && ["setup", "restore-config"].includes(positionals[0]))
		throw new Error("共享配置管理请在不带 --preset 的入口执行。");
	if (values.output && positionals[0] !== "diagnose") throw new Error("--output 仅用于 diagnose 命令");
	if (positionals[0] === "diagnose") {
		const report = await diagnosticReport(home, cwd);
		if (values.output) {
			await saveDiagnosticReport(values.output, report);
			process.stdout.write("诊断已保存；默认未包含提示词、文件或会话正文。\n");
		} else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	if (positionals[0] === "restore-config") {
		await recoverConfig(home);
		process.stdout.write("已恢复最近有效配置，损坏原件已保留。\n");
		return;
	}
	if (values.preset && values.light) throw new Error("--preset 与 --light 不能同时使用");
	const baseConfig = await loadConfig(home);
	const selectedPreset =
		values.preset && values.preset !== "legacy"
			? await resolvePreset(home, cwd, values.preset, baseConfig)
			: undefined;
	const config = selectedPreset?.config ?? baseConfig;
	if (positionals[0] === "setup") {
		if (!values.defaults) {
			if (!process.stdin.isTTY) throw new Error("非交互配置请使用 setup --defaults");
			const input = createInterface({ input: process.stdin, output: process.stdout });
			try {
				const answer = await input.question("保存 OpenCode Go / DeepSeek V4.1 Flash 与 Tavily 配置？[Y/n] ");
				if (answer.toLowerCase() === "n") return;
			} finally {
				input.close();
			}
		}
		await saveConfig(home, config);
		process.stdout.write(
			`配置已保存：${path.join(home, "config.json")}\n在终端设置 OPENCODE_API_KEY 和 TAVILY_API_KEY 后启动；--demo 可离线试用。\n`,
		);
		return;
	}
	if (positionals[0] === "doctor") {
		process.stdout.write(
			JSON.stringify(
				redact({
					app: "0.2.0",
					omp: "18.10.3",
					runtime: { engine: "bun", version: Bun.version, cwd: process.cwd() },
					platform: process.platform,
					arch: process.arch,
					home,
					cwd,
					model: { ...config.model, credentialAvailable: !!process.env[config.model.apiKeyEnv] },
					search: { provider: "tavily", credentialAvailable: !!process.env[config.search.apiKeyEnv] },
					sandbox: await sandboxCapabilities(),
					unsupported: {
						enabledExtensions: config.resources.extensions.filter(extension => extension.enabled).length,
						authFile: !!config.model.authPath,
					},
					mcp: Object.entries(config.mcpServers).map(([name, value]) => {
						try {
							if (record(value, "MCP 服务").enabled === false) return { name, status: "disabled" };
							const server = parseMcpConfig(value);
							return { name, type: server.type, status: "configured", connected: false };
						} catch (error) {
							return { name, status: "invalid", error: error instanceof Error ? error.message : String(error) };
						}
					}),
					note: "只检查配置和依赖，不代表真实服务连通或完整沙箱验收。",
				}),
				null,
				2,
			) + "\n",
		);
		return;
	}
	if (positionals.length) throw new Error(`未知命令：${positionals.join(" ")}；查看 --help`);
	if (values.print && !values.prompt) throw new Error("--print 需要 --prompt");
	if (values.print && ["goal", "btw"].includes(parseProductCommand(values.prompt ?? "")?.name ?? ""))
		throw new Error("/goal 和 /btw 需要交互终端；请正常启动后输入命令。");
	if (!values.print && !process.stdin.isTTY) throw new Error("TUI 需要真实终端；可使用 --print --prompt");
	await fs.mkdir(home, { recursive: true, mode: 0o700 });
	if (!values.demo && !process.env[config.model.apiKeyEnv])
		throw new Error(`模型未配置，请在终端设置 ${config.model.apiKeyEnv}；--demo 可离线试用`);
	const handoffToken = process.env.MY_AGENT_HANDOFF_TOKEN;
	const preparing = process.env.MY_AGENT_HANDOFF_PREPARE === "1";
	const startPlan = process.env.MY_AGENT_HANDOFF_PLAN === "1";
	delete process.env.MY_AGENT_HANDOFF_TOKEN;
	delete process.env.MY_AGENT_HANDOFF_PREPARE;
	delete process.env.MY_AGENT_HANDOFF_PLAN;
	const handoff = handoffToken && process.send ? new HandoffConnection(handoffToken) : undefined;
	const host = await openHost({
		home,
		cwd,
		demo: values.demo,
		light: values.light,
		resume: values.resume,
		interactive: !values.print,
		permissions,
		preset: values.preset,
		plan: startPlan,
		prepared: preparing,
		onAllocated:
			handoff && preparing
				? (id, file) =>
						handoff.send({ type: "allocated", session: { id, resume: file, preset: values.preset ?? "legacy" } })
				: undefined,
	});
	// CLI prompts enter the SDK directly rather than passing the TUI input hook.
	if (values.prompt) host.state.policy.setUserTask(values.prompt);
	if (values.print) {
		const abort = () => {
			void host.session.abort();
		};
		process.on("SIGINT", abort);
		process.on("SIGTERM", abort);
		try {
			host.session.subscribe(event => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
					process.stdout.write(event.assistantMessageEvent.delta);
			});
			await host.session.prompt(values.prompt!);
			process.stdout.write("\n");
			const latest = host.session.messages.filter(message => message.role === "assistant").at(-1);
			if (latest?.role === "assistant" && ["error", "aborted"].includes(latest.stopReason))
				throw new ModelRequestError(latest.errorMessage ?? "模型请求未完成");
		} finally {
			process.removeListener("SIGINT", abort);
			process.removeListener("SIGTERM", abort);
			await host.dispose();
		}
	} else {
		if (preparing && handoff) {
			try {
				await handoff.prepare(host);
				await host.activate();
			} catch (error) {
				await host.dispose();
				handoff.finish(error);
				throw error;
			}
		}
		const mode = new InteractiveMode(
			host.session,
			"My Agent 0.2.0 / OMP 18.10.3",
			undefined,
			host.setToolUIContext,
			host.lspServers,
			host.mcpManager,
			host.eventBus,
		);
		const drafts = new SessionDrafts(
			() => mode.editor,
			() => host.session.sessionManager.getSessionId(),
			mode.ui,
			discarded =>
				mode.showStatus(
					discarded ? "输入已恢复；切换期间的按键未录入，请重新输入。" : "输入已恢复 · 会话草稿已就位",
				),
		);
		host.setResumeUI(target => {
			mode.showStatus("正在切换会话，输入暂不可用；完成后恢复草稿。");
			return drafts.switch(() => mode.handleResumeSession(target, { keepModel: true }));
		});
		const ink = values.ui === "classic" ? undefined : new InkShell(mode, host.state);
		const handoffClosed = Promise.withResolvers<void>();
		let closeError: unknown;
		const unsubscribeResources = host.session.subscribeCommandMetadataChanged(() =>
			mode.setSlashCommandCatalog(productCommandCatalog(host.state)),
		);
		const shutdown = () => {
			void mode.shutdown();
		};
		process.once("SIGTERM", shutdown);
		try {
			await initializeProductInput(
				mode,
				async () => {
					await mode.init({
						suppressWelcomeIntro: true,
						autoStartCollab: false,
						keybindings: productKeybindings(),
						slashCommandCatalog: productCommandCatalog(host.state),
						resumeCommand: () =>
							host.session.sessionFile
								? productResumeCommand(
										home,
										cwd,
										host.session.sessionFile,
										values.demo === true,
										values.light === true,
										host.state.preset?.id,
									)
								: false,
					});
					if (preparing) {
						mode.cancelGoalContinuation();
						await host.session.goalRuntime.pauseGoal();
					}
					mode.addAutocompleteProvider(current =>
						createSkillAutocompleteProvider(current, () => host.state.resources.skills),
					);
					await ink?.start();
				},
				host.closed,
			);
			host.state.snapshotWritable = true;
			handoff?.attach(
				host,
				cancel => {
					mode.showStatus("正在准备预设，输入已冻结；Esc 取消。");
					const release = mode.ui.addInputListener(data => {
						if (data === "\u001b") cancel();
						return { consume: true };
					});
					return () => {
						mode.ui.terminal.discardPendingInput?.();
						release();
						mode.showStatus("交接未完成，原会话已保留。");
					};
				},
				() => handoffClosed.resolve(),
			);
			if (values.prompt) await host.session.prompt(values.prompt);
			await runProductInputLoop(mode, host.session, Promise.race([host.closed, handoffClosed.promise]));
		} finally {
			ink?.dispose();
			unsubscribeResources();
			process.removeListener("SIGTERM", shutdown);
			try {
				if (handoff?.committed) await mode.closeForHandoff();
				else mode.stop();
			} catch (error) {
				closeError = error;
			}
			try {
				await host.dispose();
			} catch (error) {
				closeError ??= error;
			}
			handoff?.finish(closeError);
		}
		if (closeError) throw closeError;
		if (handoff?.committed) await postmortem.quit(0);
	}
}

try {
	await run();
} catch (error) {
	process.stderr.write(`${String(redact(error instanceof Error ? error.message : String(error)))}\n`);
	const diagnostic = classifyError(error);
	process.stderr.write(`[${diagnostic.category}] ${diagnostic.hint}\n`);
	process.exitCode = 1;
	if (launcherToken) {
		if (process.connected && process.send)
			process.send({
				version: 1,
				token: launcherToken,
				type: "failed",
				error: String(redact(error instanceof Error ? error.message : String(error))).slice(0, 1900),
			});
		process.disconnect?.();
		await postmortem.quit(1);
	}
}
