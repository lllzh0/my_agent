import { SandboxManager as MacSandbox } from "@anthropic-ai/sandbox-runtime";
import {
	checkWindowsDependenciesAsync,
	getWindowsSandboxUserStatusAsync,
	resolveSrtWin,
	VENDORED_SRT_WIN_EXE,
} from "@my-agent/windows-sandbox";

export const windowsSandboxExecutable = { path: VENDORED_SRT_WIN_EXE };
export async function windowsSandboxDependencies() {
	const srtWin = resolveSrtWin(windowsSandboxExecutable);
	const dependencies = await checkWindowsDependenciesAsync({ srtWin, allowLoopback: false });
	if (!dependencies.errors.length) {
		const user = await getWindowsSandboxUserStatusAsync({ srtWin });
		if (user.profileGrant) dependencies.errors.push("检测到整用户目录读取授权；本入口要求未授予该权限的安装");
	}
	return dependencies;
}

export async function sandboxCapabilities() {
	const supported = process.platform === "darwin" || process.platform === "win32";
	return {
		platformSupported: supported,
		backend:
			process.platform === "win32"
				? "srt-win 0.0.81 (alpha)"
				: process.platform === "darwin"
					? "macOS Seatbelt 0.0.50"
					: "unsupported",
		dependencies: process.platform === "win32" ? await windowsSandboxDependencies() : MacSandbox.checkDependencies(),
		...(process.platform === "win32"
			? {
					setup: "bun run agent:sandbox install",
					shell: "Windows PowerShell",
					experimental: true,
					stdioMcp: "requires-explicit-full-access",
				}
			: {}),
	};
}
