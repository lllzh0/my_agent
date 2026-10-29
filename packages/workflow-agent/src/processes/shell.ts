import * as path from "node:path";
import { getShellArgs } from "@oh-my-pi/pi-utils/procmgr";
export * from "./quote";

export interface CommandInvocation {
	argv: string[];
	/** Environment needed by the launcher, separate from the sandbox child's overlay. */
	env?: Record<string, string>;
}

/** Product commands use one known language, independent of ambient shell profiles. */
export function productShell(): { exe: string; args: string[] } {
	if (process.platform === "win32") {
		const exe = path.join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		return { exe, args: ["-NonInteractive", ...getShellArgs(exe, { PI_BASH_NO_LOGIN: "1" })] };
	}
	return { exe: "/bin/bash", args: ["--noprofile", "--norc", "-c"] };
}

/** Executable shell program, not a model prompt. Preserve UTF-8 and native exit codes. */
export function commandScript(command: string): string {
	return process.platform === "win32"
		? `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $global:LASTEXITCODE=0; try { & {\n${command}\n}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } catch { [Console]::Error.WriteLine($_); exit 1 }`
		: command;
}

export function commandInvocation(command: string): CommandInvocation {
	const shell = productShell();
	return { argv: [shell.exe, ...shell.args, commandScript(command)] };
}
