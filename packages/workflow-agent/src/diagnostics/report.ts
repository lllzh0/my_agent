import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getBundledModel, isGeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { loadConfig } from "../config/config";
import { parseMcpConfig } from "../mcp/config";
import { record } from "../storage";
import productPackage from "../../package.json" with { type: "json" };
import ompPackage from "../../../coding-agent/package.json" with { type: "json" };
import { recentDiagnostics } from "./errors";

/** Export only explicit metadata fields; raw configuration and history stay local. */
export async function diagnosticReport(home: string, cwd = process.cwd()) {
	let configuration: unknown;
	try {
		const config = await loadConfig(home);
		const model = isGeneratedProvider(config.model.provider)
			? getBundledModel(config.model.provider, config.model.id)
			: undefined;
		const mcp = { configured: 0, disabled: 0, invalid: 0 };
		const selected = [
			...config.resources.instructions,
			...config.resources.skills,
			...config.resources.appendSystem,
			...(config.resources.systemPrompt ? [config.resources.systemPrompt] : []),
		];
		const available = await Promise.all(
			selected.map(file =>
				fs
					.stat(path.resolve(cwd, file))
					.then(() => true)
					.catch(() => false),
			),
		);
		for (const server of Object.values(config.mcpServers)) {
			try {
				if (record(server, "MCP 服务").enabled === false) mcp.disabled++;
				else {
					parseMcpConfig(server);
					mcp.configured++;
				}
			} catch {
				mcp.invalid++;
			}
		}
		configuration = {
			status: "valid",
			model: {
				recognized: !!model,
				...(model ? { provider: model.provider, id: model.id } : {}),
				credentialAvailable: !!process.env[config.model.apiKeyEnv],
			},
			search: { provider: config.search.provider, credentialAvailable: !!process.env[config.search.apiKeyEnv] },
			resources: {
				instructions: config.resources.instructions.length,
				skills: config.resources.skills.length,
				enabledCodeExtensions: config.resources.extensions.filter(entry => entry.enabled).length,
				unavailable: available.filter(value => !value).length,
				check: "existence-only",
			},
			permissions: {
				allowNetwork: config.permissions.allowNetwork,
				additionalReadRoots: config.permissions.readRoots.length,
			},
			mcp,
		};
	} catch {
		configuration = {
			status: "invalid",
			issue: {
				category: "configuration",
				hint: "检查 config.json 的格式与字段；可用 restore-config 恢复最近有效备份。",
			},
		};
	}
	const dependencies = SandboxManager.checkDependencies();
	return {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		app: { version: productPackage.version, omp: ompPackage.version },
		runtime: { engine: "bun", version: Bun.version, platform: process.platform, arch: process.arch },
		configuration,
		sandbox: {
			platformSupported: process.platform === "darwin",
			dependenciesAvailable: dependencies.errors.length === 0,
			dependencyIssueCount: dependencies.errors.length,
		},
		recentErrors: await recentDiagnostics(home),
		note: "仅包含诊断元数据，不含密钥、配置路径、提示词、文件或会话正文；未连接模型、搜索或 MCP。",
	};
}

export async function saveDiagnosticReport(file: string, report: unknown): Promise<void> {
	try {
		await fs.writeFile(path.resolve(file), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error("诊断输出文件已存在；请选择新文件，现有文件未修改。");
		throw error;
	}
}
