import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { TemporaryAccess, type AccessRequest } from "../src/runtime/temporary-access";
import { TemporarySkills } from "../src/skills/temporary";
import { chooseResourceAccess, skillsFromCommand } from "../src/tui/resource-access";
import { toolFixture } from "./tool-fixture";

const request: AccessRequest = {
	kind: "skill",
	key: "brainstorming",
	fingerprint: "v1",
	label: "brainstorming",
	reason: "Plan task",
	details: { path: "/skill/SKILL.md", readOnly: true },
};

test("long resource reasons cannot hide the actual skill or MCP operation details", async () => {
	for (const kind of ["skill", "mcp"] as const) {
		let selects = 0;
		let inspected = "";
		await chooseResourceAccess(
			{
				...request,
				kind,
				reason: "x".repeat(12000),
				details: { path: "/REAL_SKILL/SKILL.md", arguments: { target: "REAL_TARGET_AFTER_REASON" } },
			},
			async (_title, choices) => (selects++ === 0 ? choices[3] : undefined),
			async body => {
				inspected = body;
			},
		);
		expect(inspected).toContain("REAL_SKILL");
		expect(inspected).toContain("REAL_TARGET_AFTER_REASON");
	}
});

test("resource approval defaults to only loading this invocation and inspecting details does not approve", async () => {
	expect(
		await chooseResourceAccess(
			request,
			async (_title, choices) => choices[0],
			async () => {},
		),
	).toBe("once");
	let inspected = 0;
	let selects = 0;
	expect(
		await chooseResourceAccess(
			request,
			async (_title, choices) => (selects++ === 0 ? choices[3] : undefined),
			async () => {
				inspected++;
			},
		),
	).toBe("deny");
	expect(inspected).toBe(1);
	expect(
		await chooseResourceAccess(
			{ ...request, kind: "mcp" },
			async (_title, choices) => choices[1],
			async () => {},
		),
	).toBe("run");
});

test("skill management confirms run activation and revocation at the package read boundary", async () => {
	const f = await toolFixture();
	try {
		const file = path.join(f.state.home, "skills/example/SKILL.md");
		await Bun.write(file, "---\nname: example\ndescription: package\n---\nbody");
		f.state.home = await fs.realpath(f.state.home);
		const base = structuredClone(f.state.config);
		base.resources.skills = [file];
		f.state.access = new TemporaryAccess(f.policy);
		f.state.skillAccess = new TemporarySkills(f.state, base, f.state.access);
		await f.state.skillAccess.initialize();
		const ctx = {
			hasUI: true,
			ui: { select: async (_title: string, choices: string[]) => choices[0], notify: () => {} },
		} as unknown as ExtensionContext;
		await skillsFromCommand(f.state, ctx, "allow example", () => {});
		expect(f.state.skillAccess.list()[0]?.temporary).toBe(true);
		expect(await f.policy.resolvePath(file, "read")).toBe(await fs.realpath(file));
		await skillsFromCommand(f.state, ctx, "revoke example", () => {});
		expect(f.state.skillAccess.list()[0]?.temporary).toBe(false);
		await expect(f.policy.resolvePath(file, "read")).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("noninteractive skill writes and an idle-state change during selection cannot create a grant", async () => {
	const f = await toolFixture();
	try {
		const file = path.join(f.state.home, "skills/example/SKILL.md");
		await Bun.write(file, "---\nname: example\ndescription: package\n---\nbody");
		const base = structuredClone(f.state.config);
		base.resources.skills = [file];
		f.state.access = new TemporaryAccess(f.policy);
		f.state.skillAccess = new TemporarySkills(f.state, base, f.state.access);
		await f.state.skillAccess.initialize();
		await expect(
			skillsFromCommand(f.state, { hasUI: false } as ExtensionContext, "allow example", () => {}),
		).rejects.toThrow();
		let busy = false;
		const ctx = {
			hasUI: true,
			ui: {
				select: async (_title: string, choices: string[]) => {
					busy = true;
					return choices[0];
				},
				notify: () => {},
			},
		} as unknown as ExtensionContext;
		await expect(
			skillsFromCommand(f.state, ctx, "allow example", () => {
				if (busy) throw new Error("busy");
			}),
		).rejects.toThrow("busy");
		expect(f.state.skillAccess.list()[0]?.temporary).toBe(false);
	} finally {
		await f.close();
	}
});
