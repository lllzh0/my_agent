import * as path from "node:path";

/** Minimal by default; additional names and full inheritance require user selection. */
export function executionEnvironment(
	stateDir: string,
	envNames: string[] = [],
	fullAccess = false,
): Record<string, string> {
	const env: Record<string, string> = {};
	if (fullAccess) for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
	for (const name of [
		"PATH",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"TERM",
		...(process.platform === "win32" ? ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] : []),
		...envNames,
	])
		if (process.env[name]) env[name] = process.env[name]!;
	const scratch = path.join(stateDir, "scratch");
	env.TMPDIR = scratch;
	if (process.platform === "win32") {
		env.TEMP = scratch;
		env.TMP = scratch;
	}
	env.npm_config_cache = path.join(scratch, "npm-cache");
	env.XDG_CACHE_HOME = path.join(scratch, "cache");
	env.PIP_CACHE_DIR = path.join(scratch, "pip-cache");
	return env;
}
