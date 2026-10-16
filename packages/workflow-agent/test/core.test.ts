import assert from "node:assert/strict";
import { test } from "bun:test";
import * as fs from "node:fs/promises";
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = fs;
import * as os from "node:os";
const { tmpdir } = os;
import * as path from "node:path";
const { join } = path;
import { loadConfig, saveConfig, defaultConfig, recoverConfig } from "../src/config/config.ts";
import { Policy } from "../src/policy/policy.ts";
import { ChangeJournal } from "../src/changes/journal.ts";
import { Workflow } from "../src/workflow/workflow.ts";

test("configuration rejects inline secrets and preserves last valid file after invalid save", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-config-"));
	try {
		const config = defaultConfig();
		await saveConfig(root, config);
		await assert.rejects(saveConfig(root, { ...config, model: { ...config.model, apiKey: "private" } }), /apiKey/);
		assert.equal((await loadConfig(root)).version, 1);
		await saveConfig(root, { ...config, search: { ...config.search, maxResults: 3 } });
		await writeFile(join(root, "config.json"), "{oops");
		await assert.rejects(loadConfig(root), /config.json/);
		await assert.rejects(saveConfig(root, config));
		await recoverConfig(root);
		assert.equal((await loadConfig(root)).search.maxResults, 5);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("policy rejects symlink escape and refuses shell in plan even with approval", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-policy-"));
	try {
		const workspace = join(root, "work");
		await mkdir(workspace);
		await symlink(root, join(workspace, "escape"));
		const policy = new Policy(workspace, { readRoots: [], writeRoots: [], allowNetwork: true });
		const approvals: string[] = [];
		policy.setApprover(async request => {
			approvals.push(request.tool);
			return "once";
		});
		await assert.rejects(
			policy.authorize({ tool: "write", kind: "write", target: "escape/outside.txt" }),
			/工作区|范围/,
		);
		policy.mode = "plan";
		await assert.rejects(policy.authorize({ tool: "bash", kind: "execute", target: "echo harmless" }), /计划/);
		assert.equal(approvals.length, 0);
		policy.mode = "execute";
		await policy.authorize({ tool: "write", kind: "write", target: "file.txt" });
		assert.deepEqual(approvals, ["write"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("approval is bound to exact arguments and denial never executes a write", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-grants-"));
	try {
		const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false });
		let approvals = 0;
		policy.setApprover(async () => {
			approvals++;
			return "session";
		});
		await policy.authorize({ tool: "bash", kind: "execute", target: "echo one", parameters: { a: 1 } });
		await policy.authorize({ tool: "bash", kind: "execute", target: "echo one", parameters: { a: 1 } });
		await policy.authorize({ tool: "bash", kind: "execute", target: "echo two", parameters: { a: 1 } });
		assert.equal(approvals, 2);
		policy.setApprover(async () => "deny");
		await assert.rejects(policy.authorize({ tool: "write", kind: "write", target: "not-created.txt" }), /拒绝/);
		await assert.rejects(readFile(join(root, "not-created.txt")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("approval completed after entering plan mode is rejected without creating a reusable grant", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-pending-plan-"));
	const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: false });
	const started = Promise.withResolvers<void>();
	const approval = Promise.withResolvers<"session">();
	let approvals = 0;
	policy.setApprover(async () => {
		approvals++;
		if (approvals > 1) return "deny";
		started.resolve();
		return approval.promise;
	});
	const request = { tool: "bash", kind: "execute" as const, target: "echo pending" };
	const pending = policy.authorize(request);
	try {
		await started.promise;
		policy.mode = "plan";
		policy.clearGrants();
		approval.resolve("session");
		await assert.rejects(pending, /计划模式/);
		policy.mode = "execute";
		await assert.rejects(policy.authorize(request), /拒绝/);
		assert.equal(approvals, 2);
	} finally {
		approval.resolve("session");
		await pending.catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

test("journal restores pre-existing user edits, removes new file, and refuses changed targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-changes-"));
	try {
		const workspace = join(root, "work");
		await mkdir(workspace);
		const file = join(workspace, "file.txt");
		await writeFile(file, "user edits");
		const journal = new ChangeJournal(join(root, "state"), workspace);
		await journal.capture("turn-1", file, () => writeFile(file, "agent edits"));
		const id = journal.list()[0].id;
		await writeFile(file, "new user edits");
		await assert.rejects(journal.restore(id), /冲突/);
		assert.equal(await readFile(file, "utf8"), "new user edits");
		await writeFile(file, "agent edits");
		await journal.restore(id);
		assert.equal(await readFile(file, "utf8"), "user edits");
		const fresh = join(workspace, "new.txt");
		await journal.capture("turn-2", fresh, () => writeFile(fresh, "new"));
		await journal.restore(journal.list().at(-1)!.id);
		await assert.rejects(readFile(fresh));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workflow persists progress but refuses complete without evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-workflow-"));
	try {
		const flow = new Workflow(join(root, "workflow.json"));
		await flow.replace(["Read evidence", "Write report"]);
		await assert.rejects(flow.update(0, "completed"), /证据/);
		await flow.update(0, "completed", "source:S1");
		const restored = new Workflow(join(root, "workflow.json"));
		await restored.load();
		assert.equal(restored.tasks[0].status, "completed");
		assert.equal(restored.tasks[0].evidence, "source:S1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("batch restore checks every file before writing and combines consecutive edits to one file", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-batch-"));
	try {
		const workspace = join(root, "work");
		await mkdir(workspace);
		const a = join(workspace, "a.txt");
		const b = join(workspace, "b.txt");
		await writeFile(a, "original-a");
		await writeFile(b, "original-b");
		const journal = new ChangeJournal(join(root, "state"), workspace);
		await journal.capture("turn", a, () => writeFile(a, "a-1"));
		await journal.capture("turn", a, () => writeFile(a, "a-2"));
		await journal.capture("turn", b, () => writeFile(b, "b-1"));
		const ids = journal.list().map(x => x.id);
		await writeFile(b, "human-b");
		await assert.rejects(journal.restoreMany(ids), /冲突/);
		assert.equal(await readFile(a, "utf8"), "a-2");
		await writeFile(b, "b-1");
		await journal.restoreMany(ids);
		assert.equal(await readFile(a, "utf8"), "original-a");
		assert.equal(await readFile(b, "utf8"), "original-b");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
