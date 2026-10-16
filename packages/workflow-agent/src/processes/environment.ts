import * as path from "node:path";

/** Only non-credential host settings cross into managed subprocesses. */
export function executionEnvironment(stateDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TERM"])
		if (process.env[name]) env[name] = process.env[name]!;
	const scratch = path.join(stateDir, "scratch");
	env.TMPDIR = scratch;
	env.npm_config_cache = path.join(scratch, "npm-cache");
	env.XDG_CACHE_HOME = path.join(scratch, "cache");
	env.PIP_CACHE_DIR = path.join(scratch, "pip-cache");
	return env;
}
