import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { loadConfig, saveConfig, recoverConfig } from "./config/config";
import { openHost } from "./runtime/host";
import { redact, record } from "./storage";
import { parseMcpConfig } from "./mcp/config";
import { productKeybindings, productResumeCommand } from "./tui/options";
import { parseProductCommand, productCommandCatalog } from "./tui/commands";
import { runProductInputLoop } from "./tui/input-loop";
import { diagnosticReport, saveDiagnosticReport } from "./diagnostics/report";
import { classifyError, ModelRequestError } from "./diagnostics/errors";
import type { ApprovalMode } from "./policy/policy";

async function run(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			demo: { type: "boolean" },
			light: { type: "boolean" },
			print: { type: "boolean", short: "p" },
			defaults: { type: "boolean" },
			home: { type: "string" },
			cwd: { type: "string" },
			prompt: { type: "string" },
			resume: { type: "string" },
			output: { type: "string" },
			permissions: { type: "string" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"My Agent 0.2.0 · OMP\n编程与资料研究\n\n用法：bun run agent [setup|doctor|diagnose|restore-config] [选项]\n  setup --defaults       保存默认模型与搜索配置，不发送请求\n  doctor                 检查配置和运行依赖，不发送请求\n  diagnose               预览脱敏诊断 JSON，不发送请求\n  diagnose --output 文件 保存诊断到新文件，不覆盖已有文件\n  --demo                 本地模拟回答，不调用真实服务\n  --light                不加载工作流资源和工具\n  --print --prompt 文本  输出一次回答；副作用默认拒绝\n  --home 路径            独立配置和会话目录\n  --cwd 路径             工作目录\n  --resume 会话文件      恢复当前配置目录内的 OMP 产品会话\n  --permissions 模式     manual 手动、auto 自动、full 完整授权；仅本次启动\n\n终端主菜单 /agent；计划模式 /agent-plan。配置修改在重启后生效。\n模型凭据：OPENCODE_API_KEY；搜索凭据：TAVILY_API_KEY。\n",
		);
		return;
	}
	const selectedPermissions = values.permissions;
	if (selectedPermissions !== undefined && !["manual", "auto", "full"].includes(selectedPermissions))
		throw new Error("--permissions 只支持 manual、auto 或 full");
	const permissions = selectedPermissions as ApprovalMode | undefined;
	const home = path.resolve(process.env.MY_AGENT_HOME ?? values.home ?? path.join(os.homedir(), ".my-agent-omp"));
	const cwd = path.resolve(process.env.MY_AGENT_CWD ?? values.cwd ?? process.cwd());
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
	const config = await loadConfig(home);
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
					sandbox: {
						platformSupported: process.platform === "darwin",
						dependencies: SandboxManager.checkDependencies(),
					},
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
	const host = await openHost({
		home,
		cwd,
		demo: values.demo,
		light: values.light,
		resume: values.resume,
		interactive: !values.print,
		permissions,
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
		const mode = new InteractiveMode(
			host.session,
			"My Agent 0.2.0 / OMP 18.10.3",
			undefined,
			host.setToolUIContext,
			host.lspServers,
			host.mcpManager,
			host.eventBus,
		);
		host.setResumeUI(target => mode.handleResumeSession(target, { keepModel: true }));
		const shutdown = () => {
			void mode.shutdown();
		};
		process.once("SIGTERM", shutdown);
		try {
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
							)
						: false,
			});
			if (values.prompt) await host.session.prompt(values.prompt);
			await runProductInputLoop(mode, host.session, host.closed);
		} finally {
			process.removeListener("SIGTERM", shutdown);
			await host.dispose();
		}
	}
}

try {
	await run();
} catch (error) {
	process.stderr.write(`${String(redact(error instanceof Error ? error.message : String(error)))}\n`);
	const diagnostic = classifyError(error);
	process.stderr.write(`[${diagnostic.category}] ${diagnostic.hint}\n`);
	process.exitCode = 1;
}
