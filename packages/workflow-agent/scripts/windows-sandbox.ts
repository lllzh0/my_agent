#!/usr/bin/env bun
import { installWindowsSandboxAsync, resolveSrtWin } from "@my-agent/windows-sandbox";
import { windowsSandboxDependencies, windowsSandboxExecutable } from "../src/processes/sandbox-status";

try {
	if (process.platform !== "win32") throw new Error("此命令仅用于原生 Windows 沙箱。");
	const command = process.argv[2] ?? "status";
	if (process.argv.length > 3 || !["install", "status"].includes(command))
		throw new Error("用法：bun run agent:sandbox [status|install]");
	if (command === "install") {
		process.stdout.write(
			"安装 Windows alpha 沙箱：创建 srt-sandbox 本地账户、受限用户组和 WFP 网络规则，需要一次管理员 UAC；不授予整个用户目录读取权限，不开放任意本地端口。\n",
		);
		await installWindowsSandboxAsync({ skipProfileGrant: true, srtWin: resolveSrtWin(windowsSandboxExecutable) });
	}
	const dependencies = await windowsSandboxDependencies();
	process.stdout.write(`${JSON.stringify({ backend: "srt-win 0.0.81 (alpha)", ...dependencies }, null, 2)}\n`);
	if (dependencies.errors.length) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
