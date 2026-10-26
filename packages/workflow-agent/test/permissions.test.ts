import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Policy } from "../src/policy/policy";
import { defaultConfig, validateConfig } from "../src/config/config";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createReviewer } from "../src/policy/reviewer";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-permissions-"));
	const workspace = path.join(root, "work");
	await fs.mkdir(workspace);
	return { root, workspace, policy: new Policy(workspace, { readRoots: [], writeRoots: [], allowNetwork: false }) };
}

test("managed skill read access does not expose application state, allow writes, or follow escaping links", async () => {
	const f = await fixture();
	try {
		const home = path.join(f.root, "home");
		const skill = path.join(home, "skills", "selected");
		const reference = path.join(skill, "references", "guide.md");
		await Bun.write(reference, "reference");
		await Bun.write(path.join(home, "config.json"), "private state");
		await fs.symlink(path.join(home, "config.json"), path.join(skill, "escape"));
		f.policy.protectedRoots = [home];
		f.policy.managedSkillReadRoots.push(skill);
		f.policy.settings.readRoots.push(skill);
		expect(await f.policy.resolvePath(reference, "read")).toBe(await fs.realpath(reference));
		await expect(f.policy.resolvePath(reference, "write")).rejects.toThrow(/受保护/);
		await expect(f.policy.resolvePath(path.join(skill, "escape"), "read")).rejects.toThrow(/受保护/);
		await expect(f.policy.resolvePath(path.join(home, "config.json"), "read")).rejects.toThrow(/受保护/);
		f.policy.managedSkillReadRoots.splice(0, 1, home, path.join(home, "skills"));
		await expect(f.policy.resolvePath(reference, "read")).rejects.toThrow(/受保护/);
	} finally {
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("auto allows changing ordinary project files without reapproving each content version", async () => {
	const f = await fixture();
	try {
		let prompts = 0;
		f.policy.setApprover(async () => {
			prompts++;
			return "deny";
		});
		f.policy.setApprovalMode("auto");
		const target = path.join(f.workspace, "notes.txt");
		for (const content of ["first", "second"]) {
			await f.policy.authorize({ tool: "write", kind: "write", target, parameters: { content } });
			await Bun.write(target, content);
		}
		expect(await Bun.file(target).text()).toBe("second");
		expect(prompts).toBe(0);
	} finally {
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("auto reviews commands and defers dangerous or failed reviews to a person before side effects", async () => {
	const f = await fixture();
	try {
		let prompts = 0;
		f.policy.setApprover(async () => {
			prompts++;
			return "deny";
		});
		f.policy.setApprovalMode("auto");
		f.policy.setReviewer(async () => ({ decision: "allow", risk: "low", reason: "bounded test" }));
		await f.policy.authorize({ tool: "bash", kind: "execute", target: "bun test" });
		await expect(
			f.policy.authorize({ tool: "bash", kind: "execute", target: "git reset --hard HEAD" }),
		).rejects.toThrow(/拒绝/);
		f.policy.setReviewer(async () => {
			throw new Error("provider unavailable");
		});
		const target = path.join(f.workspace, "should-not-exist.txt");
		await expect(
			(async () => {
				await f.policy.authorize({ tool: "bash", kind: "execute", target: "some-script" });
				await Bun.write(target, "bad");
			})(),
		).rejects.toThrow(/拒绝/);
		expect(await Bun.file(target).exists()).toBe(false);
		expect(prompts).toBe(2);
	} finally {
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("mode changes revoke in-flight review instead of granting permissions to a different mode", async () => {
	const f = await fixture();
	const review = Promise.withResolvers<{ decision: "allow"; risk: "low"; reason: string }>();
	const started = Promise.withResolvers<void>();
	try {
		f.policy.setApprovalMode("auto");
		f.policy.setReviewer(async () => {
			started.resolve();
			return review.promise;
		});
		const pending = f.policy.authorize({ tool: "bash", kind: "execute", target: "bun test" });
		await started.promise;
		f.policy.setApprovalMode("manual");
		review.resolve({ decision: "allow", risk: "low", reason: "old context" });
		await expect(pending).rejects.toThrow(/状态|变更/);
		await expect(f.policy.authorize({ tool: "bash", kind: "execute", target: "bun test" })).rejects.toThrow(/拒绝/);
	} finally {
		review.resolve({ decision: "allow", risk: "low", reason: "cleanup" });
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("cancelling an ignored review signal stops authorization without a prompt or write", async () => {
	const f = await fixture();
	const pendingReview = Promise.withResolvers<{ decision: "allow"; risk: "low"; reason: string }>();
	try {
		let prompts = 0;
		f.policy.setApprover(async () => {
			prompts++;
			return "once";
		});
		f.policy.setApprovalMode("auto");
		f.policy.setReviewer(() => pendingReview.promise);
		await expect(
			f.policy.authorize({ tool: "bash", kind: "execute", target: "bun test" }, AbortSignal.timeout(20)),
		).rejects.toThrow();
		expect(prompts).toBe(0);
	} finally {
		pendingReview.resolve({ decision: "allow", risk: "low", reason: "cleanup" });
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("full permits external paths and network but never changes independent plan mode", async () => {
	const f = await fixture();
	try {
		const target = path.join(f.root, "outside.txt");
		await expect(f.policy.resolvePath(target, "write")).rejects.toThrow(/范围/);
		f.policy.setApprovalMode("full");
		await f.policy.authorize({ tool: "write", kind: "write", target });
		await Bun.write(await f.policy.resolvePath(target, "write"), "FULL_OK");
		await f.policy.authorize({ tool: "web_fetch", kind: "network", target: "https://example.com" });
		expect(await Bun.file(target).text()).toBe("FULL_OK");
		f.policy.mode = "plan";
		await expect(f.policy.authorize({ tool: "write", kind: "write", target })).rejects.toThrow(/计划/);
	} finally {
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("configuration accepts auto but refuses silently persistent full access", () => {
	const config = defaultConfig();
	validateConfig({ ...config, permissions: { ...config.permissions, approval: "auto" } });
	expect(() => validateConfig({ ...config, permissions: { ...config.permissions, approval: "full" } })).toThrow(
		/完整|full/,
	);
});

function reviewServer(policy: Policy) {
	const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
	let reply = "allow";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model: string; messages: { role: string; content: unknown }[] };
			requests.push(body);
			const base = { id: "review", object: "chat.completion.chunk", created: 1, model: body.model };
			const frames = [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
				{
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
				},
			];
			return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const model = {
		...getBundledModel("opencode-go", "deepseek-v4.1-flash"),
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
	};
	policy.setReviewer(createReviewer(model, "offline-local-placeholder", "review-fixture", policy));
	return {
		requests,
		setReply(value: string) {
			reply = value;
		},
		close() {
			server.stop(true);
		},
	};
}

test("permission model replies must be exact labels before auto can skip a person", async () => {
	const f = await fixture();
	const model = reviewServer(f.policy);
	try {
		let prompts = 0;
		f.policy.setApprover(async () => {
			prompts++;
			return "deny";
		});
		f.policy.setApprovalMode("auto");
		f.policy.setUserTask("Run the project checks");
		await f.policy.authorize({ tool: "bash", kind: "execute", target: "python check.py" });
		expect(prompts).toBe(0);
		model.setReply("Do not allow this request; uncertain.");
		await expect(f.policy.authorize({ tool: "bash", kind: "execute", target: "python check.py" })).rejects.toThrow(
			/拒绝/,
		);
		expect(prompts).toBe(1);
		expect(model.requests).toHaveLength(2);
		expect(f.policy.reviewUsage.requests).toBe(2);
		expect(f.policy.reviewUsage.tokens).toBe(60);
	} finally {
		model.close();
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("permission review includes user constraints after the first 12000 characters", async () => {
	const f = await fixture();
	const model = reviewServer(f.policy);
	try {
		const constraint = "Do not publish anything or change deployment settings.";
		f.policy.setApprovalMode("auto");
		f.policy.setUserTask(`Check the project notes. ${"x".repeat(12_050)}\n${constraint}`);
		await f.policy.authorize({ tool: "bash", kind: "execute", target: "python check.py" });
		const state = model.requests[0]?.messages.find(message => message.role === "user");
		expect(JSON.stringify(state?.content).includes(constraint)).toBe(true);
	} finally {
		model.close();
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

test("permission review exceeding 32KB asks a person without making a model request", async () => {
	const f = await fixture();
	const model = reviewServer(f.policy);
	try {
		let prompts = 0;
		f.policy.setApprover(async request => {
			prompts++;
			expect(request.review?.risk).toBe("unknown");
			return "deny";
		});
		f.policy.setApprovalMode("auto");
		f.policy.setUserTask("汉".repeat(11_000));
		await expect(f.policy.authorize({ tool: "bash", kind: "execute", target: "python check.py" })).rejects.toThrow(
			/拒绝/,
		);
		expect(prompts).toBe(1);
		expect(model.requests).toHaveLength(0);
	} finally {
		model.close();
		await fs.rm(f.root, { recursive: true, force: true });
	}
});
