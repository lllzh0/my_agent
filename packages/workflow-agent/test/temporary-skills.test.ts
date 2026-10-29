import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillPromptMessage } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { defaultConfig } from "../src/config/config";
import { Policy } from "../src/policy/policy";
import { loadResources } from "../src/runtime/resources";
import type { RunState } from "../src/runtime/state";
import { TemporaryAccess, type AccessDecision, type AccessRequest } from "../src/runtime/temporary-access";
import { TemporarySkills } from "../src/skills/temporary";

function skillText(name = "reviewer", body = "ORIGINAL_APPROVED_INSTRUCTIONS"): string {
	return `---\nname: ${name}\ndescription: Review supplied code\n---\n${body}\n`;
}

test("ending a turn while its skill snapshot is being read cannot reactivate that skill", async () => {
	const f = await fixture();
	try {
		f.access.setApprover(async () => "once");
		const pending = f.skills.prepare("reviewer", "", "read");
		f.skills.finishTurn();
		await expect(pending).rejects.toThrow();
		expect(f.skills.effectiveSkills()).toEqual([]);
		await expect(f.policy.resolvePath(f.file, "read")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("shared grant revocation immediately removes skill package reads", async () => {
	const f = await fixture();
	try {
		await f.skills.grant("reviewer");
		f.access.revoke("skill");
		await expect(f.policy.resolvePath(f.file, "read")).rejects.toThrow();
		f.access.setApprover(async () => "once");
		await f.skills.prepare("reviewer", "", "read");
		f.access.revoke("tool");
		await expect(f.policy.resolvePath(f.file, "read")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("an unselected same-name candidate cannot hide the explicitly selected baseline skill", async () => {
	const f = await fixture();
	try {
		const alternate = path.join(f.home, "skills/alternate/SKILL.md");
		await Bun.write(alternate, skillText("reviewer", "UNSELECTED_COLLISION"));
		f.baseConfig.resources.skills.push(alternate);
		f.config.resources.skills = [f.file];
		f.state.resources = await loadResources(f.config, f.cwd, false);
		await f.skills.initialize();
		expect(f.skills.effectiveSkills().map(skill => skill.filePath)).toEqual([f.file]);
		expect((await f.skills.load("reviewer", "baseline", "explicit preset selection")).message).toContain(
			"ORIGINAL_APPROVED_INSTRUCTIONS",
		);
		expect(f.skills.list().find(entry => entry.path === alternate)?.error).toBeDefined();
	} finally {
		await f.close();
	}
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "temporary-skills-")));
	const cwd = path.join(root, "workspace");
	const home = path.join(root, "app-home");
	const file = path.join(home, "skills", "reviewer", "SKILL.md");
	await fs.mkdir(cwd);
	await Bun.write(file, skillText());
	await Bun.write(path.join(path.dirname(file), "reference.md"), "PACKAGE_REFERENCE");
	const baseConfig = defaultConfig();
	baseConfig.resources.skills = [file];
	const config = structuredClone(baseConfig);
	config.resources.skills = [];
	config.resources.disabled = ["tool:bash"];
	const policy = new Policy(cwd, { readRoots: [], writeRoots: [], allowNetwork: false });
	policy.protectedRoots.push(home);
	const resources = await loadResources(config, cwd, false);
	const state = { home, cwd, config, policy, resources, light: false, sessionId: "first", turn: "first" } as RunState;
	const access = new TemporaryAccess(policy);
	const skills = new TemporarySkills(state, baseConfig, access);
	await skills.initialize();
	return {
		root,
		cwd,
		home,
		file,
		baseConfig,
		config,
		policy,
		state,
		access,
		skills,
		async close() {
			skills.close();
			access.close();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("a preset-excluded registered skill needs its own approval without changing preset resources", async () => {
	const f = await fixture();
	try {
		const config = JSON.stringify([f.baseConfig, f.config]);
		const signature = f.state.resources.signature;
		expect(f.skills.list()).toEqual([
			expect.objectContaining({ name: "reviewer", path: f.file, enabled: false, temporary: false }),
		]);
		await expect(f.skills.load("reviewer", "focus on bugs", "需要代码审查")).rejects.toThrow();
		const requests: AccessRequest[] = [];
		f.access.setApprover(async request => {
			requests.push(request);
			return "once";
		});
		const output = await f.skills.load("reviewer", "focus on bugs", "需要代码审查");
		expect(output.message).toContain("ORIGINAL_APPROVED_INSTRUCTIONS");
		expect(output.details).toMatchObject({ name: "reviewer", path: f.file, args: "focus on bugs" });
		expect(requests[0]).toMatchObject({
			kind: "skill",
			key: "reviewer",
			details: { name: "reviewer", path: f.file, args: "focus on bugs", hash: f.skills.list()[0].hash },
		});
		expect(JSON.stringify([f.baseConfig, f.config])).toBe(config);
		expect(f.state.resources.signature).toBe(signature);
		expect(f.skills.effectiveSkills().map(skill => skill.name)).toEqual(["reviewer"]);
		f.skills.finishTurn();
		expect(f.skills.effectiveSkills()).toEqual([]);
		f.access.setApprover(async () => "deny");
		await expect(f.skills.load("reviewer", "again", "重新加载")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("a disabled selected skill still needs approval in full policy mode", async () => {
	const f = await fixture();
	try {
		f.config.resources.skills = [f.file];
		f.config.resources.disabled!.push("skill:reviewer");
		f.state.resources = await loadResources(f.config, f.cwd, false);
		f.policy.setApprovalMode("full");
		await f.skills.initialize();
		await expect(f.skills.prepare("reviewer", "", "用户未批准能力")).rejects.toThrow();
		expect(f.skills.effectiveSkills()).toEqual([]);
	} finally {
		await f.close();
	}
});

test("prepared native dispatch uses a frozen body even when the source changes afterwards", async () => {
	const f = await fixture();
	try {
		f.access.setApprover(async () => "once");
		await f.skills.prepare("reviewer", "native args", "用户调用");
		await Bun.write(f.file, skillText("reviewer", "UNAPPROVED_CHANGED_BODY"));
		const nativeSkill = f.skills.effectiveSkills().find(skill => skill.name === "reviewer")!;
		const built = await buildSkillPromptMessage(nativeSkill, { args: "native args" });
		expect(built.message).toContain("ORIGINAL_APPROVED_INSTRUCTIONS");
		expect(built.message).not.toContain("UNAPPROVED_CHANGED_BODY");
	} finally {
		await f.close();
	}
});

test("a skill changed during approval never exposes either body or a reusable run grant", async () => {
	const f = await fixture();
	try {
		f.access.setApprover(async () => {
			await Bun.write(f.file, skillText("reviewer", "CHANGED_DURING_APPROVAL"));
			return "run";
		});
		await expect(f.skills.load("reviewer", "", "加载")).rejects.toThrow(/变|重新/);
		expect(f.skills.effectiveSkills()).toEqual([]);
		await expect(f.policy.resolvePath(path.join(path.dirname(f.file), "reference.md"), "read")).rejects.toThrow();
		f.access.setApprover(async () => "deny");
		await expect(f.skills.load("reviewer", "", "再次加载")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("run survives a new conversation but changed content needs approval again", async () => {
	const f = await fixture();
	try {
		let approvals = 0;
		f.access.setApprover(async () => {
			approvals++;
			return approvals === 1 ? "run" : "deny";
		});
		await f.skills.load("reviewer", "first", "代码审查");
		f.skills.finishTurn();
		f.state.sessionId = "next-conversation";
		await f.skills.load("reviewer", "second", "继续审查");
		expect(approvals).toBe(1);
		expect(f.skills.list()[0]).toMatchObject({ enabled: false, temporary: true });
		await Bun.write(f.file, skillText("reviewer", "NEW_VERSION"));
		await expect(f.skills.load("reviewer", "third", "新内容")).rejects.toThrow();
		expect(approvals).toBe(2);
		expect(f.skills.effectiveSkills()).toEqual([]);
		await expect(f.policy.resolvePath(path.join(path.dirname(f.file), "reference.md"), "read")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("once adds only package reads and finishTurn removes them while preserving other roots", async () => {
	const f = await fixture();
	try {
		const baseline = path.join(f.root, "baseline");
		await Bun.write(path.join(baseline, "notes.md"), "BASELINE");
		f.policy.settings.readRoots.push(baseline);
		await Bun.write(path.join(path.dirname(f.file), ".env.local"), "FIXTURE_ONLY");
		const outside = path.join(f.root, "outside.md");
		await Bun.write(outside, "OUTSIDE");
		await fs.symlink(outside, path.join(path.dirname(f.file), "escape.md"));
		f.access.setApprover(async () => "once");
		await f.skills.prepare("reviewer", "", "读取包资料");
		const reference = path.join(path.dirname(f.file), "reference.md");
		expect(await f.policy.resolvePath(reference, "read")).toBe(reference);
		await expect(f.policy.resolvePath(reference, "write")).rejects.toThrow();
		await expect(f.policy.resolvePath(path.join(path.dirname(f.file), ".env.local"), "read")).rejects.toThrow();
		await expect(f.policy.resolvePath(path.join(path.dirname(f.file), "escape.md"), "read")).rejects.toThrow();
		expect(() => f.policy.checkMode({ tool: "fetch", kind: "network", target: "https://example.invalid" })).toThrow();
		expect(f.config.resources.disabled).toContain("tool:bash");
		f.skills.finishTurn();
		await expect(f.policy.resolvePath(reference, "read")).rejects.toThrow();
		expect(await f.policy.resolvePath(path.join(baseline, "notes.md"), "read")).toBe(path.join(baseline, "notes.md"));
	} finally {
		await f.close();
	}
});

test("revoking one run skill keeps another package and dynamically selected baseline readable", async () => {
	const f = await fixture();
	try {
		const second = path.join(f.home, "skills", "second", "SKILL.md");
		const baseline = path.join(f.home, "skills", "baseline", "SKILL.md");
		await Bun.write(second, skillText("second"));
		await Bun.write(baseline, skillText("baseline"));
		f.baseConfig.resources.skills.push(second);
		await f.skills.initialize();
		await f.skills.grant("reviewer");
		await f.skills.grant("second");
		f.config.resources.skills.push(baseline);
		f.state.resources = await loadResources(f.config, f.cwd, false);
		f.policy.settings.readRoots.push(path.dirname(baseline));
		f.policy.managedSkillReadRoots.push(path.dirname(baseline));
		f.skills.syncReadRoots();
		f.skills.revoke("reviewer");
		await expect(f.policy.resolvePath(f.file, "read")).rejects.toThrow();
		expect(await f.policy.resolvePath(second, "read")).toBe(second);
		expect(
			f.skills
				.effectiveSkills()
				.map(skill => skill.name)
				.sort(),
		).toEqual(["baseline", "second"]);
		f.skills.close();
		expect(await f.policy.resolvePath(baseline, "read")).toBe(baseline);
		await expect(f.policy.resolvePath(second, "read")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

for (const invalidation of ["cancel", "revoke", "finish", "policy", "close"] as const) {
	test(`${invalidation} during approval prevents a late skill run grant and package access`, async () => {
		const f = await fixture();
		try {
			const entered = Promise.withResolvers<void>();
			const decision = Promise.withResolvers<AccessDecision>();
			const controller = new AbortController();
			f.access.setApprover(async () => {
				entered.resolve();
				return decision.promise;
			});
			const pending = f.skills.load("reviewer", "", "等待批准", controller.signal).catch((error: unknown) => error);
			await entered.promise;
			if (invalidation === "cancel") controller.abort();
			else if (invalidation === "revoke") f.skills.revoke("reviewer");
			else if (invalidation === "finish") f.skills.finishTurn();
			else if (invalidation === "policy") f.policy.clearGrants();
			else f.skills.close();
			decision.resolve("run");
			expect(await pending).toBeInstanceOf(Error);
			expect(f.skills.effectiveSkills()).toEqual([]);
			await expect(f.policy.resolvePath(f.file, "read")).rejects.toThrow();
		} finally {
			await f.close();
		}
	});
}

test("duplicate names and invalid optional candidates never prevent baseline startup or become executable", async () => {
	const f = await fixture();
	try {
		const duplicate = path.join(f.root, "other-reviewer", "SKILL.md");
		const invalid = path.join(f.root, "invalid", "SKILL.md");
		const missing = path.join(f.root, "missing", "SKILL.md");
		await Bun.write(duplicate, skillText());
		await Bun.write(invalid, "---\nname: invalid\n---\nMissing description");
		f.baseConfig.resources.skills.push(duplicate, invalid, missing);
		await f.skills.initialize();
		expect(f.skills.list().filter(item => item.error).length).toBe(4);
		f.access.setApprover(async () => "run");
		await expect(f.skills.prepare("reviewer", "", "不能任挑重名")).rejects.toThrow(/重复|歧义|同名/);
		await expect(f.skills.prepare("invalid", "", "无效技能")).rejects.toThrow();
		await expect(f.skills.prepare("unknown", "", "未知技能")).rejects.toThrow();
		expect(f.skills.effectiveSkills()).toEqual([]);
	} finally {
		await f.close();
	}
});

test("active baseline skills bypass temporary approval and reflect hot-reloaded resources", async () => {
	const f = await fixture();
	try {
		f.config.resources.skills.push(f.file);
		f.state.resources = await loadResources(f.config, f.cwd, false);
		await f.skills.initialize();
		f.access.setApprover(async () => "deny");
		expect((await f.skills.load("reviewer", "", "已选择技能")).message).toContain("ORIGINAL_APPROVED_INSTRUCTIONS");
		f.skills.finishTurn();
		expect(f.skills.effectiveSkills().map(skill => skill.name)).toEqual(["reviewer"]);
		f.state.resources = { ...f.state.resources, skills: [] };
		expect(f.skills.effectiveSkills()).toEqual([]);
		await expect(f.skills.load("reviewer", "", "现在未选择")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("light mode exposes no candidates, and fresh access has no prior run skill", async () => {
	const f = await fixture();
	try {
		await f.skills.grant("reviewer");
		const cold = new TemporarySkills(f.state, f.baseConfig, new TemporaryAccess(f.policy));
		await cold.initialize();
		expect(cold.effectiveSkills()).toEqual([]);
		cold.close();
		f.state.light = true;
		await f.skills.initialize();
		expect(f.skills.list()).toEqual([]);
		await expect(f.skills.load("reviewer", "", "轻量模式")).rejects.toThrow();
		await expect(f.skills.grant("reviewer")).rejects.toThrow();
	} finally {
		await f.close();
	}
});
