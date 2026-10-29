#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { readPreset } from "./presets/presets";
import { presetCommand } from "./presets/cli";
import { CLI_OPTIONS } from "./cli-options";
import { launchPreset } from "./presets/defaults";

// The SDK caches directories during module initialization. Keep this process
// free of SDK imports and give the session child its owned paths up front.
try {
	const { values, positionals } = parseArgs({
		strict: false,
		allowPositionals: true,
		options: { ...CLI_OPTIONS, template: { type: "string" }, clear: { type: "boolean" } },
	});
	const cwd = path.resolve(typeof values.cwd === "string" ? values.cwd : (process.env.MY_AGENT_CWD ?? process.cwd()));
	const home = path.resolve(
		typeof values.home === "string"
			? values.home
			: (process.env.MY_AGENT_HOME ?? path.join(os.homedir(), ".my-agent-omp")),
	);
	if (positionals[0] === "preset") {
		if (values.preset || values.light) throw new Error("预设管理命令不与 --preset 或 --light 混用");
		process.stdout.write(
			`${JSON.stringify(await presetCommand(home, cwd, positionals.slice(1), typeof values.template === "string" ? values.template : undefined, values.clear === true), null, 2)}\n`,
		);
		process.exit(0);
	}
	const selectedPreset = await launchPreset(home, cwd, {
		preset: typeof values.preset === "string" ? values.preset : undefined,
		resume: typeof values.resume === "string" ? values.resume : undefined,
		light: values.light === true,
		help: values.help === true,
		command: positionals[0],
	});
	if (selectedPreset && values.light) throw new Error("--preset 与 --light 不能同时使用");
	if (selectedPreset && selectedPreset !== "legacy" && ["setup", "restore-config"].includes(positionals[0]))
		throw new Error("共享配置管理请在不带 --preset 的入口执行。");
	if (selectedPreset && selectedPreset !== "legacy") await readPreset(home, selectedPreset);
	const configRoot =
		selectedPreset && selectedPreset !== "legacy"
			? path.join(home, "omp", "presets", selectedPreset)
			: path.join(home, "omp");
	const childArgs = process.argv.slice(2);
	if (selectedPreset && !values.preset) {
		const separator = childArgs.indexOf("--");
		childArgs.splice(separator < 0 ? childArgs.length : separator, 0, "--preset", selectedPreset);
	}
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cli.ts"), ...childArgs], {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: {
			...process.env,
			MY_AGENT_HOME: home,
			MY_AGENT_CWD: cwd,
			PI_CONFIG_DIR: path.relative(os.homedir(), configRoot),
			PI_CONFIG_FILES: "",
			PI_CODING_AGENT_DIR: path.join(configRoot, "agent"),
			PI_NATIVES_DIR: path.join(home, "natives"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_APP_NAME: "my-agent",
		},
	});
	const terminate = () => child.kill("SIGTERM");
	process.once("SIGTERM", terminate);
	// Interactive terminal signals reach both processes in their foreground group.
	const interrupt = () => {
		if (!process.stdin.isTTY) child.kill("SIGINT");
	};
	process.on("SIGINT", interrupt);
	try {
		process.exitCode = await child.exited;
	} finally {
		process.removeListener("SIGTERM", terminate);
		process.removeListener("SIGINT", interrupt);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
