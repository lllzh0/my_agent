import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverExternalSkills } from "../src/skills/external";
import { fixture } from "./helpers";

async function skill(directory: string, name: string) {
	await Bun.write(
		path.join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: >\n  selected skill\n  with support files\n---\nbody`,
	);
}

test("external discovery is read-only, includes agents and nested system skills, and isolates malformed candidates", async () => {
	const f = await fixture();
	try {
		await skill(path.join(f.home, ".agents/skills/first"), "first");
		await skill(path.join(f.cwd, ".codex/skills/.system/nested"), "nested");
		await skill(path.join(f.home, ".agents/skills/node_modules/hidden"), "hidden");
		await Bun.write(path.join(f.home, ".agents/skills/broken/SKILL.md"), "---\nname: [\ndescription: invalid\n---\n");
		const result = await discoverExternalSkills({ home: f.home, cwd: f.cwd });
		expect(result.candidates.map(candidate => candidate.name).sort()).toEqual(["first", "nested"]);
		expect(result.candidates[0].description).toContain("support files");
		expect(result.diagnostics.some(item => item.path.includes("broken"))).toBe(true);
		expect(f.config.resources.skills).toEqual([]);
		expect(await Bun.file(path.join(f.home, "config.json")).exists()).toBe(false);
	} finally {
		await f.close();
	}
});

test("external discovery rejects escaping links and bounds cyclic or overly deep trees", async () => {
	const f = await fixture();
	try {
		const root = path.join(f.root, "source");
		await skill(path.join(root, "good"), "good");
		await skill(path.join(f.root, "outside"), "outside");
		await fs.symlink(path.join(f.root, "outside"), path.join(root, "escape"));
		await fs.symlink(root, path.join(root, "loop"));
		await fs.symlink(path.join(root, "missing"), path.join(root, "zzz-broken"));
		await skill(path.join(root, ...Array.from({ length: 10 }, () => "deep")), "too-deep");
		const result = await discoverExternalSkills({ home: f.home, roots: [{ label: "custom", path: root }] });
		expect(result.candidates.map(candidate => candidate.name)).toEqual(["good"]);
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(result.truncated).toBe(true);
		const controller = new AbortController();
		controller.abort();
		await expect(
			discoverExternalSkills({ home: f.home, roots: [{ label: "custom", path: root }], signal: controller.signal }),
		).rejects.toThrow();
	} finally {
		await f.close();
	}
});

for (const scenario of [
	"copy",
	"link",
	"conflicts",
	"rollback",
	"cancel",
	"busy",
	"unsafe",
	"unknown",
	"concurrency",
	"mid-cancel",
	"batch-conflicts",
	"safe-links",
	"cyclic-links",
	"link-unsafe",
	"ui-cancel",
	"target-conflict",
	"managed-conflict",
	"managed-link-conflict",
	"oversized",
	"light",
	"ui",
	"ui-same-directory",
]) {
	test(`external skill import: ${scenario}`, async () => {
		const f = await fixture();
		try {
			await skill(path.join(f.root, "source/first"), "first");
			await skill(path.join(f.root, "source/second"), "second");
			await skill(path.join(f.root, "source/duplicate"), "first");
			await Bun.write(path.join(f.root, "source/first/references/example.txt"), "SUPPORT_FILE");
			await Bun.write(path.join(f.root, "source/broken/SKILL.md"), "---\nname: [\n---\n");
			await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "external-skills-worker.ts"),
					JSON.stringify({ root: f.root, home: f.home, cwd: f.cwd, scenario }),
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: f.root,
						TERM: "dumb",
						PRODUCT_TEST_KEY: "fake-local-key",
						PI_CONFIG_DIR: path.relative(f.root, path.join(f.home, "omp")),
						PI_CODING_AGENT_DIR: path.join(f.home, "omp/agent"),
						PI_NATIVES_DIR: path.join(f.home, "natives"),
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
			if (scenario === "copy" || scenario === "link") {
				expect(f.requests).toHaveLength(2);
				expect(JSON.stringify(f.requests[0].messages)).toContain("selected skill with support files");
				expect(JSON.stringify(f.requests[1].messages)).not.toContain("selected skill with support files");
			}
		} finally {
			await f.close();
		}
	}, 30000);
}
