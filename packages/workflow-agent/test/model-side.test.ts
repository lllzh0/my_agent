import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

for (const scenario of ["complete", "abort", "lock", "rollback"])
	test(`real localhost side request ${scenario} respects product transition lifecycle`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-side-model-"));
		try {
			const home = path.join(root, "home");
			const cwd = path.join(root, "workspace");
			const resultFile = path.join(root, "result.json");
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "model-side-worker.ts"),
					JSON.stringify({ home, cwd, resultFile, scenario }),
				],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH,
						HOME: os.homedir(),
						TERM: "dumb",
						PI_CONFIG_DIR: path.relative(os.homedir(), path.join(home, "omp")),
						PI_CODING_AGENT_DIR: path.join(home, "omp/agent"),
						PI_NATIVES_DIR: path.join(home, "natives"),
						OMP_APP_NAME: "my-agent",
						OMP_PROFILE: "",
						PI_PROFILE: "",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [code, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect(code, stderr).toBe(0);
			const result = await Bun.file(resultFile).json();
			if (scenario === "complete" || scenario === "abort") {
				expect(result.activeWhileHeld).toBe(true);
				expect(result.modelBlocked).toBe(true);
				expect(result.newBlocked).toBe(true);
				expect(result.reviewBlocked).toBe(true);
				expect(result.identityPreserved).toBe(true);
				expect(result.filesPreserved).toBe(true);
				expect(result.activeAfter).toBe(false);
				expect(result.selectedAfter).toBe("b");
				expect(result.requests).toBe(1);
				if (scenario === "complete") expect(result.sideResult).toBe("SIDE_OK");
			} else if (scenario === "lock") {
				expect(result.admittedWhileLocked).toBe(false);
				expect(result.lockError).toContain("正在切换模型");
				expect(result.activeDuringLock).toBe(false);
				expect(result.activeAfter).toBe(false);
				expect(result.requests).toBe(0);
			} else {
				expect(result.admittedAfterRollback).toBe(false);
				expect(result.rollbackError).toContain("回退失败");
				expect(result.activeAfter).toBe(false);
				expect(result.requests).toBe(0);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 20000);
