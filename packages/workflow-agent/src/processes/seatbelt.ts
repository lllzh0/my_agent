import { parse, quote } from "shell-quote";
import { filterManagedSkillRoots } from "../policy/policy";

/** Add final macOS deny rules after ASRT's broad workspace read exception.
 * ASRT 0.0.50 emits allowRead after denyRead, so a workspace exception otherwise
 * reopens credentials and an application home nested in that workspace.
 * Parse only the runtime-generated argv; never evaluate the command text.
 */
export function protectMacOSCommand(
	wrapped: string,
	home: string,
	scratch: string,
	gitWrite = false,
	managedSkillReadRoots: readonly string[] = [],
): string {
	const parsed = parse(wrapped).map(arg => {
		if (typeof arg === "string") return arg;
		// shell-quote marks ASRT's escaped *.local proxy exception as a glob.
		// It is an env assignment, not a shell expansion; quote it again below.
		if ("op" in arg && arg.op === "glob" && /^(NO_PROXY|no_proxy)=/.test(arg.pattern)) return arg.pattern;
		throw new Error("沙箱命令格式不符合预期；拒绝执行");
	});
	const index = parsed.indexOf("/usr/bin/sandbox-exec");
	if (index < 0 || parsed[index + 1] !== "-p" || !parsed[index + 2]?.startsWith("(version 1)"))
		throw new Error("缺少 macOS 沙箱配置；拒绝执行");
	const owned = `(require-all (subpath ${JSON.stringify(home)}) (require-not (subpath ${JSON.stringify(scratch)})))`;
	const readProtected = `(require-all (subpath ${JSON.stringify(home)}) (require-not (subpath ${JSON.stringify(scratch)})) ${filterManagedSkillRoots(
		home,
		managedSkillReadRoots,
	)
		.map(root => `(require-not (subpath ${JSON.stringify(root)}))`)
		.join(" ")})`;
	const secrets = String.raw`(^|/)(\.ssh|\.aws|\.gnupg|\.env(\.[^/]+)?|env\.local|auth\.json|mcp-auth\.json|id_rsa|id_ed25519|[^/]+\.(pem|key))(/|$)`;
	const executionConfig = gitWrite
		? String.raw`(^|/)(\.agents|\.codex|\.pi|\.omp)(/|$)`
		: String.raw`(^|/)(\.git|\.agents|\.codex|\.pi|\.omp)(/|$)`;
	parsed[index + 2] +=
		`\n(deny file-write* ${owned})\n(deny file-read* ${readProtected})\n(deny file-read* file-write* (regex ${JSON.stringify(secrets)}))\n(deny file-write* (regex ${JSON.stringify(executionConfig)}))`;
	return quote(parsed);
}
