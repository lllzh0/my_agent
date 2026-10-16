import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "../src/config/config";
import { fixture } from "./helpers";
import { diagnosticReport } from "../src/diagnostics/report";
import { classifyError, Diagnostics, recentDiagnostics } from "../src/diagnostics/errors";

const launcher = path.resolve(import.meta.dir, "../src/launcher.ts");
async function diagnosticFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-diagnostic-project-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "workspace");
	await fs.mkdir(cwd);
	const run = async (args: string[] = []) => {
		const child = Bun.spawn([process.execPath, launcher, "diagnose", ...args, "--home", home, "--cwd", cwd], {
			env: {
				PATH: process.env.PATH,
				HOME: os.homedir(),
				TERM: "dumb",
				DIAGNOSTIC_TEST_KEY: "fake-private-diagnostic-key",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	};
	return { root, home, cwd, run, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test("diagnose reports credential availability without exporting secrets, project paths or session content and stays offline", async () => {
	const f = await diagnosticFixture();
	let connections = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			connections++;
			return new Response("unexpected");
		},
	});
	try {
		const config = defaultConfig();
		config.model.apiKeyEnv = "DIAGNOSTIC_TEST_KEY";
		config.resources.instructions = [path.join(f.cwd, "PRIVATE_INSTRUCTION.md")];
		config.resources.skills = [path.join(f.cwd, "PRIVATE_MISSING_SKILL")];
		config.mcpServers = { fixture: { url: `http://127.0.0.1:${server.port}/mcp` } };
		await Bun.write(config.resources.instructions[0], "PRIVATE_PROMPT_BODY");
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(config));
		await Bun.write(path.join(f.home, "sessions/private.jsonl"), "PRIVATE_CHAT_BODY");
		await Bun.write(
			path.join(f.home, "state/private/manifest.json"),
			JSON.stringify({
				cwd: f.cwd,
				resources: [{ path: config.resources.instructions[0], text: "PRIVATE_FILE_BODY" }],
			}),
		);
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		const report = JSON.parse(run.stdout);
		expect(report.configuration.status).toBe("valid");
		expect(report.configuration.model.provider).toBe("opencode-go");
		expect(report.configuration.model.id).toBe("deepseek-v4.1-flash");
		expect(report.configuration.model.credentialAvailable).toBe(true);
		expect(report.configuration.search.credentialAvailable).toBe(false);
		expect(report.configuration.resources.unavailable).toBe(1);
		for (const privateText of [
			"fake-private-diagnostic-key",
			f.root,
			"PRIVATE_INSTRUCTION",
			"PRIVATE_PROMPT_BODY",
			"PRIVATE_CHAT_BODY",
			"PRIVATE_FILE_BODY",
		])
			expect(run.stdout).not.toContain(privateText);
		expect(connections).toBe(0);
	} finally {
		server.stop(true);
		await f.close();
	}
}, 30000);

test("diagnostic model identifiers come only from the bundled catalog, including for unrecognized private values", async () => {
	const f = await diagnosticFixture();
	try {
		for (const provider of ["private-token-with-no-prefix", "opencode-go"]) {
			const config = defaultConfig();
			config.model.provider = provider;
			config.model.id = "/Users/private-team/project\nPRIVATE_MODEL_BODY";
			await Bun.write(path.join(f.home, "config.json"), JSON.stringify(config));
			const report = await diagnosticReport(f.home);
			const output = JSON.stringify(report);
			expect(output).not.toContain("private-token-with-no-prefix");
			expect(output).not.toContain("/Users/private-team");
			expect(output).not.toContain("PRIVATE_MODEL_BODY");
			expect(report.configuration).toMatchObject({ status: "valid", model: { recognized: false } });
		}
	} finally {
		await f.close();
	}
});

test("recent diagnostics include errors from an older session after more than 200 session directories exist", async () => {
	const f = await diagnosticFixture();
	try {
		const state = path.join(f.home, "state");
		await Promise.all(
			Array.from({ length: 201 }, (_, i) => fs.mkdir(path.join(state, String(i)), { recursive: true })),
		);
		const first = (await fs.readdir(state))[0];
		const diagnostics = new Diagnostics(path.join(state, first));
		diagnostics.record("runtime", new Error("HTTP 429"));
		await diagnostics.flush();
		expect(await recentDiagnostics(f.home)).toMatchObject([{ category: "rate_limit", httpStatus: 429 }]);
	} finally {
		await f.close();
	}
});

test("diagnostic categories distinguish throttling, transport, timeout, cancellation, malformed data and configuration failures", () => {
	const cases = [
		{ error: { status: 429, message: "invalid api key PRIVATE_DETAIL" }, category: "rate_limit" },
		{ error: { status: 503, message: "PRIVATE_DETAIL" }, category: "network" },
		{ error: Object.assign(new Error("PRIVATE_DETAIL"), { code: "ECONNRESET" }), category: "network" },
		{ error: new Error("资料读取超时 PRIVATE_DETAIL"), category: "timeout" },
		{
			error: new Error("OpenAI completions stream stalled while waiting for the next event PRIVATE_DETAIL"),
			category: "timeout",
		},
		{
			error: new Error("Anthropic stream stalled while waiting for the next event PRIVATE_DETAIL"),
			category: "timeout",
		},
		{ error: new DOMException("PRIVATE_DETAIL", "AbortError"), category: "cancelled" },
		{ error: new SyntaxError("PRIVATE_DETAIL"), category: "parsing" },
		{ error: new Error("resources.skills 配置无效 PRIVATE_DETAIL"), category: "configuration" },
		{ error: new Error("opaque vendor failure PRIVATE_DETAIL"), category: "unknown" },
		{ error: new Error("401 opaque local error PRIVATE_DETAIL"), category: "unknown" },
	] as const;
	for (const entry of cases) {
		const result = classifyError(entry.error);
		expect(result.category).toBe(entry.category);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_DETAIL");
	}
});

test("diagnostic export rebuilds stored metadata instead of trusting imported hints or arbitrary fields", async () => {
	const f = await diagnosticFixture();
	try {
		await Bun.write(
			path.join(f.home, "state/fixture/errors.json"),
			JSON.stringify([
				{
					at: "2026-10-15T00:00:00.000Z",
					origin: "tool",
					category: "permission",
					hint: "PRIVATE_IMPORTED_HINT",
					message: "PRIVATE_IMPORTED_BODY",
					httpStatus: 403,
				},
				{ at: "PRIVATE_IMPORTED_DATE", origin: "tool", category: "permission" },
			]),
		);
		const report = await diagnosticReport(f.home);
		expect(report.recentErrors).toHaveLength(1);
		expect(report.recentErrors[0].httpStatus).toBe(403);
		expect(JSON.stringify(report)).not.toContain("PRIVATE_IMPORTED");
	} finally {
		await f.close();
	}
});

test("a diagnostic disk failure does not reject the original error handling path", async () => {
	const f = await diagnosticFixture();
	try {
		const blocked = path.join(f.root, "file-instead-of-state-directory");
		await Bun.write(blocked, "keep");
		const diagnostics = new Diagnostics(blocked);
		diagnostics.record("runtime", new Error("HTTP 401"));
		await diagnostics.flush();
		expect(diagnostics.writeFailed).toBe(true);
		expect(await Bun.file(blocked).text()).toBe("keep");
	} finally {
		await f.close();
	}
});

test("diagnose still exports a safe configuration failure when the configuration cannot be parsed", async () => {
	const f = await diagnosticFixture();
	try {
		const broken = '{"PRIVATE_BROKEN_FRAGMENT":';
		await Bun.write(path.join(f.home, "config.json"), broken);
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		const report = JSON.parse(run.stdout);
		expect(report.configuration.status).toBe("invalid");
		expect(report.configuration.issue.category).toBe("configuration");
		expect(run.stdout).not.toContain("PRIVATE_BROKEN_FRAGMENT");
		expect(run.stdout).not.toContain(f.root);
		expect(await Bun.file(path.join(f.home, "config.json")).text()).toBe(broken);
	} finally {
		await f.close();
	}
}, 30000);

test("a missing local file named 401 is not classified as an HTTP authentication failure", async () => {
	const f = await fixture();
	try {
		f.callTool("read", { path: "401" });
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		const report = await diagnosticReport(f.home);
		expect(report.recentErrors).toHaveLength(1);
		expect(report.recentErrors[0].category).toBe("unknown");
		expect(report.recentErrors[0].httpStatus).toBeUndefined();
	} finally {
		await f.close();
	}
}, 30000);

test("diagnostic file export refuses to overwrite an existing file", async () => {
	const f = await diagnosticFixture();
	try {
		const output = path.join(f.root, "diagnostic.json");
		const first = await f.run(["--output", output]);
		expect(first.code, first.stderr).toBe(0);
		const saved = await Bun.file(output).text();
		expect(JSON.parse(saved).configuration.status).toBe("valid");
		const second = await f.run(["--output", output]);
		expect(second.code).toBe(1);
		expect(await Bun.file(output).text()).toBe(saved);
	} finally {
		await f.close();
	}
}, 30000);

test("a denied tool leaves a safe persisted diagnostic that survives the host process", async () => {
	const f = await fixture();
	try {
		f.callTool("write", { path: "private.txt", content: "PRIVATE_TOOL_BODY" });
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		const states = await fs.readdir(path.join(f.home, "state"));
		const file = Bun.file(path.join(f.home, "state", states[0], "errors.json"));
		expect(await file.exists()).toBe(true);
		const events = await file.json();
		expect(events.at(-1).origin).toBe("tool");
		expect(events.at(-1).category).toBe("permission");
		const report = await diagnosticReport(f.home);
		expect(JSON.stringify(report)).toContain('"category":"permission"');
		for (const secret of ["PRIVATE_TOOL_BODY", "PRODUCT_HISTORY", "fake-local-key", f.root])
			expect(JSON.stringify(report)).not.toContain(secret);
		expect(await Bun.file(path.join(f.cwd, "private.txt")).exists()).toBe(false);
	} finally {
		await f.close();
	}
}, 30000);

test("a real model authentication error records a category without exporting the provider body", async () => {
	const f = await fixture();
	try {
		f.failModel(401, "PRIVATE_PROVIDER_BODY fake-local-key");
		await f.run();
		const states = await fs.readdir(path.join(f.home, "state"));
		const file = Bun.file(path.join(f.home, "state", states[0], "errors.json"));
		expect(await file.exists()).toBe(true);
		const events = await file.json();
		expect(events.at(-1).origin).toBe("model");
		expect(events.at(-1).category).toBe("authentication");
		const report = JSON.stringify(await diagnosticReport(f.home));
		for (const secret of ["PRIVATE_PROVIDER_BODY", "PRODUCT_HISTORY", "fake-local-key", f.root])
			expect(report).not.toContain(secret);
	} finally {
		await f.close();
	}
}, 30000);

test("the print CLI preserves the model origin when an opaque provider response begins with its status", async () => {
	const f = await fixture();
	try {
		f.failModel(401, "OPAQUE_PROVIDER_FAILURE");
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const child = Bun.spawn(
			[process.execPath, launcher, "--print", "--prompt", "hello", "--home", f.home, "--cwd", f.cwd],
			{
				env: { PATH: process.env.PATH, HOME: os.homedir(), TERM: "dumb", PRODUCT_TEST_KEY: "fake-local-key" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		expect(code).toBe(1);
		expect(stderr).toContain("[authentication]");
	} finally {
		await f.close();
	}
}, 30000);
