import { expect, test } from "bun:test";
import * as path from "node:path";
import { fixture, HOST_STARTUP_ATTEMPTS, HOST_TEST_TIMEOUT } from "./helpers";
import * as fs from "node:fs/promises";

test(
	"failed host initialization releases its session lease while the embedding process stays alive",
	async () => {
		const f = await fixture();
		let failedHost: Promise<unknown> | undefined;
		try {
			const first = await f.run();
			expect(first.code, first.stderr).toBe(0);
			const id = (await fs.readdir(path.join(f.home, "state")))[0];
			const manifest = path.join(f.home, "state", id, "manifest.json");
			const saved = await Bun.file(manifest).text();
			await Bun.write(manifest, "{broken");
			failedHost = f.run({ resume: first.result.sessionFile, action: "failed-open-stays" });
			for (
				let i = 0;
				i < HOST_STARTUP_ATTEMPTS && !(await Bun.file(path.join(f.home, "failure-ready")).exists());
				i++
			)
				await Bun.sleep(10);
			expect(await Bun.file(path.join(f.home, "failure-ready")).text()).not.toContain(
				"expected initialization failure",
			);
			await Bun.write(manifest, saved);
			const resumed = await f.run({ resume: first.result.sessionFile });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.sessionFile).toBe(first.result.sessionFile);
		} finally {
			await Bun.write(path.join(f.home, "failure-release"), "release");
			await failedHost;
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"queued native writes and edits stop when plan mode begins after approval",
	async () => {
		const f = await fixture();
		try {
			await Bun.write(path.join(f.cwd, "existing.txt"), "original");
			const run = await f.run({ action: "queued-files-plan", approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.actionResult).toHaveLength(2);
			for (const item of run.result.actionResult) expect(item).toContain("计划模式");
			expect(await Bun.file(path.join(f.cwd, "queued.txt")).exists()).toBe(false);
			expect(await Bun.file(path.join(f.cwd, "existing.txt")).text()).toBe("original");
			expect(run.result.changes).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"file tools reject a revoked authorization before recording or writing any content",
	async () => {
		const f = await fixture();
		try {
			const run = await f.run({ action: "revoked-files" });
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.actionResult).toHaveLength(3);
			for (const item of run.result.actionResult) expect(item).toMatch(/状态|变更/);
			expect(await Bun.file(path.join(f.cwd, "created.txt")).exists()).toBe(false);
			expect(await Bun.file(path.join(f.cwd, "report.md")).exists()).toBe(false);
			expect(await Bun.file(path.join(f.cwd, "existing.txt")).text()).toBe("ORIGINAL");
			expect(run.result.changes).toHaveLength(0);
			expect(f.requests).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"resuming a session owned by another live process fails before tools run and remains resumable after release",
	async () => {
		const f = await fixture();
		let owner: Promise<unknown> | undefined;
		try {
			const first = await f.run();
			expect(first.code, first.stderr).toBe(0);
			owner = f.run({ resume: first.result.sessionFile, action: "hold-session" });
			for (let i = 0; i < HOST_STARTUP_ATTEMPTS && !(await Bun.file(path.join(f.home, "owner-ready")).exists()); i++)
				await Bun.sleep(10);
			expect(await Bun.file(path.join(f.home, "owner-ready")).exists()).toBe(true);
			const before = await Bun.file(first.result.sessionFile).text();
			f.callTool("write", { path: "contested.txt", content: "must not execute" });
			const contested = await f.run({ resume: first.result.sessionFile, approve: true });
			expect(contested.code, contested.stderr).toBe(1);
			expect(contested.stderr).toContain("占用");
			expect(await Bun.file(path.join(f.cwd, "contested.txt")).exists()).toBe(false);
			expect(await Bun.file(first.result.sessionFile).text()).toBe(before);
			await Bun.write(path.join(f.home, "owner-release"), "release");
			await owner;
			owner = undefined;
			const resumed = await f.run({ resume: first.result.sessionFile });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.sessionFile).toBe(first.result.sessionFile);
		} finally {
			await Bun.write(path.join(f.home, "owner-release"), "release");
			await owner;
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"selecting one valid SKILL.md does not scan unrelated malformed child skills",
	async () => {
		const f = await fixture();
		try {
			const chosen = path.join(f.root, "chosen/SKILL.md");
			await Bun.write(chosen, "---\nname: chosen\ndescription: CHOSEN_ONLY\n---\nSELECTED_BODY\n");
			await Bun.write(
				path.join(f.root, "chosen/unselected/SKILL.md"),
				"---\nname: invalid/name\ndescription: UNSELECTED_POISON\n---\nUNSELECTED_BODY\n",
			);
			f.config.resources.skills = [chosen];
			const run = await f.run();
			expect(run.code, run.stderr).toBe(0);
			expect(JSON.stringify(f.requests)).toContain("CHOSEN_ONLY");
			expect(JSON.stringify(f.requests)).not.toContain("UNSELECTED");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"actual OMP request contains selected resources and cannot discover project instructions or code",
	async () => {
		const f = await fixture();
		try {
			await Bun.write(path.join(f.root, "AGENTS.md"), "ANCESTOR_POISON");
			await Bun.write(path.join(f.cwd, "AGENTS.md"), "PROJECT_POISON");
			await Bun.write(path.join(f.cwd, ".omp/SYSTEM.md"), "SYSTEM_POISON");
			const effect = path.join(f.root, "ambient-effect");
			await Bun.write(
				path.join(f.cwd, ".omp/extensions/poison.js"),
				`await Bun.write(${JSON.stringify(effect)}, 'bad'); export default function () {}`,
			);
			await Bun.write(path.join(f.root, "selected.md"), "SELECTED_INSTRUCTION");
			await Bun.write(
				path.join(f.root, "skill/SKILL.md"),
				"---\nname: chosen\ndescription: SELECTED_SKILL\n---\nSKILL_BODY_NOT_PRELOADED\n",
			);
			f.config.resources.instructions = [path.join(f.root, "selected.md")];
			f.config.resources.skills = [path.join(f.root, "skill")];
			const run = await f.run();
			expect(run.code, run.stderr).toBe(0);
			const wire = JSON.stringify(f.requests);
			expect(wire).toContain("SELECTED_INSTRUCTION");
			expect(wire).toContain("SELECTED_SKILL");
			expect(wire).not.toMatch(/ANCESTOR_POISON|PROJECT_POISON|SYSTEM_POISON|SKILL_BODY_NOT_PRELOADED/);
			expect(await Bun.file(effect).exists()).toBe(false);
			expect(run.result.tools).toContain("web_search");
			for (const name of ["eval", "task", "browser", "python", "xdev"]) expect(run.result.tools).not.toContain(name);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"single-agent host sends core tools without team tools and creates no collaboration database",
	async () => {
		const f = await fixture();
		try {
			f.callTool("write", { path: "single-agent.txt", content: "CORE_WRITE_WORKS" });
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(path.join(f.cwd, "single-agent.txt")).text()).toBe("CORE_WRITE_WORKS");
			expect(run.result.changes).toHaveLength(1);
			expect(f.requests.length).toBeGreaterThanOrEqual(2);
			for (const request of f.requests) {
				const tools = (request.tools ?? []).map(tool => tool.function.name);
				for (const name of ["read", "write", "edit", "bash", "grep", "find", "web_search"])
					expect(tools).toContain(name);
				expect(tools.filter(name => name.startsWith("team_"))).toEqual([]);
			}
			const files = await fs.readdir(run.result.stateDir, { recursive: true });
			expect(files.filter(file => file.includes("collaboration"))).toEqual([]);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"light launch ignores selected workflow files and exposes no model tools",
	async () => {
		const f = await fixture();
		try {
			f.config.resources.instructions = [path.join(f.root, "not-present.md")];
			const run = await f.run({ light: true });
			expect(run.code, run.stderr).toBe(0);
			expect(f.requests[0].tools ?? []).toHaveLength(0);
			expect(run.result.resources.filter((entry: { loaded: boolean }) => entry.loaded)).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"ambient OMP configuration is ignored even inside the owned state directory",
	async () => {
		const f = await fixture();
		try {
			await Bun.write(path.join(f.home, "omp/agent/.omp/config.yml"), "shellPath: /bin/sh\n");
			const run = await f.run();
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.shellPath).toBeNull();
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"native model configuration is not silently imported into the product model",
	async () => {
		const f = await fixture();
		try {
			await Bun.write(
				path.join(f.home, "omp/agent/models.yml"),
				"providers:\n  opencode-go:\n    modelOverrides:\n      deepseek-v4.1-flash:\n        name: AMBIENT_MODEL_CONFIG\n",
			);
			const run = await f.run();
			expect(run.code, run.stderr).toBe(0);
			expect(run.result.modelName).not.toBe("AMBIENT_MODEL_CONFIG");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"denied write has no effect; approved write is journaled and resume validates ownership, workspace and resources",
	async () => {
		const f = await fixture();
		try {
			const file = path.join(f.cwd, "result.txt");
			f.callTool("write", { path: file, content: "saved" });
			const denied = await f.run();
			expect(denied.code, denied.stderr).toBe(0);
			expect(await Bun.file(file).exists()).toBe(false);
			expect(JSON.stringify(denied.result.messages)).toContain("拒绝");
			const allowed = await f.run({ approve: true });
			expect(allowed.code, allowed.stderr).toBe(0);
			expect(await Bun.file(file).exists(), JSON.stringify(allowed.result.messages)).toBe(true);
			expect(await Bun.file(file).text()).toBe("saved");
			expect(allowed.result.changes).toHaveLength(1);
			const resumed = await f.run({ resume: allowed.result.sessionFile });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.changes).toHaveLength(1);
			expect(
				resumed.result.messages.filter((message: { role: string }) => message.role === "user").length,
			).toBeGreaterThan(1);
			const otherCwd = path.join(f.root, "another-workspace");
			await Bun.write(path.join(otherCwd, "fixture.txt"), "workspace fixture");
			const wrongWorkspace = await f.run({ resume: allowed.result.sessionFile, cwd: otherCwd });
			expect(wrongWorkspace.code).toBe(1);
			expect(wrongWorkspace.stderr).toContain("工作区不一致");
			const other = await fixture();
			try {
				const wrongHome = await other.run({ resume: allowed.result.sessionFile });
				expect(wrongHome.code).toBe(1);
				expect(wrongHome.stderr).toContain("当前产品配置目录");
			} finally {
				await other.close();
			}
			f.config.permissions.allowNetwork = true;
			const mismatch = await f.run({ resume: allowed.result.sessionFile });
			expect(mismatch.code).toBe(1);
			expect(mismatch.stderr).toContain("配置");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"native user shell cannot bypass the product execution boundary",
	async () => {
		const f = await fixture();
		try {
			const file = path.join(f.cwd, "bypass");
			const run = await f.run({ approve: true, action: "user-bash", command: `touch '${file}'` });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(file).exists()).toBe(false);
			expect(run.result.actionResult.exitCode).not.toBe(0);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"native read selectors cannot bypass the product credential-file boundary",
	async () => {
		const f = await fixture();
		try {
			await Bun.write(path.join(f.cwd, ".env"), "PRODUCT_SECRET_FIXTURE");
			f.callTool("read", { path: ".env:raw" });
			const run = await f.run();
			expect(run.code, run.stderr).toBe(0);
			expect(JSON.stringify(run.result.messages)).not.toContain("PRODUCT_SECRET_FIXTURE");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"native OMP configuration directories cannot be written through product tools",
	async () => {
		const f = await fixture();
		try {
			const target = path.join(f.cwd, ".omp/config.yml");
			f.callTool("write", { path: target, content: "shellPath: /bin/sh" });
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(target).exists()).toBe(false);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"unadapted native commands cannot reload discovery or start their own execution paths",
	async () => {
		const f = await fixture();
		try {
			for (const command of ["/mcp reload", "/reload-plugins", "/cd ..", "/ssh host"]) {
				const run = await f.run({ action: "input", command });
				expect(run.code, run.stderr).toBe(0);
				expect(run.result.actionResult?.handled, command).toBe(true);
			}
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"native Python and session switching remain blocked even with tool approval",
	async () => {
		const f = await fixture();
		try {
			const python = await f.run({ action: "user-python", approve: true });
			expect(python.code, python.stderr).toBe(0);
			expect(python.result.actionResult.exitCode).toBe(1);
			const switched = await f.run({ action: "new-session", approve: true });
			expect(switched.code, switched.stderr).toBe(0);
			expect(switched.result.actionResult).toBe(false);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"a selected skill named after a native command cannot unlock that command",
	async () => {
		const f = await fixture();
		try {
			const skill = path.join(f.root, "mcp/SKILL.md");
			await Bun.write(
				skill,
				"---\nname: mcp\ndescription: selected skill with a colliding name\n---\nUse the product tools.\n",
			);
			f.config.resources.skills = [skill];
			const native = await f.run({ action: "input", command: "/mcp reload" });
			expect(native.code, native.stderr).toBe(0);
			expect(native.result.actionResult?.handled).toBe(true);
			const selected = await f.run({ action: "input", command: "$mcp" });
			expect(selected.code, selected.stderr).toBe(0);
			expect(selected.result.actionResult?.handled).not.toBe(true);
			expect(selected.result.actionResult?.text).toBe("/skill:mcp");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"unsupported code extensions fail before execution and configured MCP commands do not run at startup",
	async () => {
		const f = await fixture();
		try {
			const effect = path.join(f.root, "extension-effect");
			const extension = path.join(f.root, "extension.ts");
			await Bun.write(extension, `await Bun.write(${JSON.stringify(effect)}, 'bad'); export default function () {}`);
			f.config.resources.extensions = [{ path: extension, enabled: true }];
			const ext = await f.run();
			expect(ext.code).toBe(1);
			expect(ext.stderr).toContain("扩展");
			expect(await Bun.file(effect).exists()).toBe(false);
			f.config.resources.extensions = [];
			f.config.mcpServers = { pending: { command: "/usr/bin/touch", args: [effect] } };
			const mcp = await f.run();
			expect(mcp.code, mcp.stderr).toBe(0);
			expect(await Bun.file(effect).exists()).toBe(false);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"native edit retains user content and the product journal can restore it",
	async () => {
		const f = await fixture();
		try {
			const file = path.join(f.cwd, "edited.txt");
			await Bun.write(file, "user content\nold\n");
			f.callTool("edit", { path: file, old_string: "old", new_string: "new" });
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(file).text()).toBe("user content\nnew\n");
			expect(run.result.changes).toHaveLength(1);
			const restored = await f.run({ resume: run.result.sessionFile, action: "restore" });
			expect(restored.code, restored.stderr).toBe(0);
			expect(await Bun.file(file).text()).toBe("user content\nold\n");
			expect(restored.result.changes[0].restored).toBe(true);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"file reads support explicit line ranges and record a selected skill read",
	async () => {
		const f = await fixture();
		try {
			const skill = path.join(f.root, "chosen/SKILL.md");
			await Bun.write(skill, "---\nname: chosen\ndescription: skill metadata\n---\nSKILL_EXPLICIT_READ\n");
			f.config.resources.skills = [skill];
			f.callTool("read", { path: skill, offset: 5, limit: 1 });
			const run = await f.run();
			expect(run.code, run.stderr).toBe(0);
			expect(JSON.stringify(run.result.messages)).toContain("SKILL_EXPLICIT_READ");
			expect(run.result.resources.find((entry: { kind: string }) => entry.kind === "skill").bodyLoaded).toBe(true);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"an edit that exceeds the journal text limit is rejected before changing the file",
	async () => {
		const f = await fixture();
		try {
			const file = path.join(f.cwd, "large.txt");
			const before = "replace-me\n" + "a".repeat(500_000);
			await Bun.write(file, before);
			f.callTool("edit", { path: file, old_string: "replace-me", new_string: "b".repeat(600_000) });
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect((await Bun.file(file).text()) === before).toBe(true);
			expect(run.result.changes).toHaveLength(0);
			expect(JSON.stringify(run.result.messages)).toContain("1MB");
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);

test(
	"an oversized report does not leave a file without a recovery record",
	async () => {
		const f = await fixture();
		try {
			const file = path.join(f.cwd, "large-report.md");
			f.callTool("write_report", {
				path: file,
				claims: [{ text: "x".repeat(1_000_001), sourceIds: [], inference: true }],
			});
			const run = await f.run({ approve: true });
			expect(run.code, run.stderr).toBe(0);
			expect(await Bun.file(file).exists()).toBe(false);
			expect(run.result.changes).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	HOST_TEST_TIMEOUT,
);
