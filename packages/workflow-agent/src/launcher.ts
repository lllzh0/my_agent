#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

// The SDK caches directories during module initialization. Keep this process
// free of SDK imports and give the session child its owned paths up front.
try {
	const { values } = parseArgs({
		strict: false,
		allowPositionals: true,
		options: { home: { type: "string" }, cwd: { type: "string" } },
	});
	const cwd = path.resolve(typeof values.cwd === "string" ? values.cwd : (process.env.MY_AGENT_CWD ?? process.cwd()));
	const home = path.resolve(
		typeof values.home === "string"
			? values.home
			: (process.env.MY_AGENT_HOME ?? path.join(os.homedir(), ".my-agent-omp")),
	);
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cli.ts"), ...process.argv.slice(2)], {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: {
			...process.env,
			MY_AGENT_HOME: home,
			MY_AGENT_CWD: cwd,
			PI_CONFIG_DIR: path.relative(os.homedir(), path.join(home, "omp")),
			PI_CONFIG_FILES: "",
			PI_CODING_AGENT_DIR: path.join(home, "omp/agent"),
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
