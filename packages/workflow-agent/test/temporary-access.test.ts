import { expect, test } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { Type } from "@oh-my-pi/omptype/typebox";
import * as path from "node:path";
import { Policy } from "../src/policy/policy";
import {
	TemporaryAccess,
	type AccessDecision,
	type AccessKind,
	type AccessRequest,
} from "../src/runtime/temporary-access";
import { TemporaryTools } from "../src/runtime/temporary-tools";
import { toolFixture } from "./tool-fixture";

function accessFixture() {
	const policy = new Policy("/workspace", { readRoots: [], writeRoots: [], allowNetwork: false });
	return { policy, access: new TemporaryAccess(policy) };
}

function request(kind: AccessKind, key = "same", fingerprint = "v1"): AccessRequest {
	return {
		kind,
		key,
		fingerprint,
		label: key,
		reason: "使用已登记资源",
		details: { arguments: { value: "approved" } },
	};
}

const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });

function writableTool(policy: Policy): ToolDefinition<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description: "Write approved content",
		parameters: writeSchema,
		async execute(_id, input, signal) {
			await policy.authorize({ tool: "write", kind: "write", target: input.path }, signal);
			await Bun.write(input.path, input.content);
			return { content: [{ type: "text", text: "saved" }], details: {} };
		},
	};
}

test("run grants with the same key never cross tool, skill, or MCP namespaces", async () => {
	const { access } = accessFixture();
	access.setApprover(async input => (input.kind === "tool" ? "run" : "deny"));
	expect(await access.request(request("tool"))).toBe("run");
	expect(await access.request(request("tool"))).toBe("enabled");
	for (const kind of ["skill", "mcp"] as const) {
		expect(await access.request(request(kind))).toBe("deny");
		expect(access.has(kind, "same", "v1")).toBe(false);
	}
	access.close();
});

test("changed resource fingerprints require a fresh decision and once leaves no reusable grant", async () => {
	const { access } = accessFixture();
	access.setApprover(async input => (input.fingerprint === "v1" ? "run" : "once"));
	expect(await access.request(request("skill"))).toBe("run");
	expect(access.has("skill", "same", "v2")).toBe(false);
	expect(await access.request(request("skill", "same", "v2"))).toBe("once");
	expect(access.has("skill", "same", "v2")).toBe(false);
	access.setApprover(async () => "deny");
	expect(await access.request(request("skill", "same", "v2"))).toBe("deny");
	access.close();
});

test("revoking a namespace removes only its grants and returned entries cannot mutate the store", () => {
	const { access } = accessFixture();
	access.grant("tool", "same", "v1");
	access.grant("skill", "same", "v1");
	access.grant("mcp", "same", "v1");
	const entries = access.entries("skill");
	entries[0]!.fingerprint = "changed";
	expect(access.has("skill", "same", "v1")).toBe(true);
	access.revoke("tool");
	expect(access.has("tool", "same", "v1")).toBe(false);
	expect(access.has("skill", "same", "v1")).toBe(true);
	expect(access.has("mcp", "same", "v1")).toBe(true);
	access.revoke("skill", "different");
	expect(access.has("skill", "same", "v1")).toBe(true);
	access.revoke("skill", "same");
	expect(access.has("skill", "same", "v1")).toBe(false);
	access.revoke();
	expect(access.entries()).toEqual([]);
	access.close();
});

test("all resource kinds share one human queue and cancelled replies cannot grant run", async () => {
	const { access } = accessFixture();
	const entered = Promise.withResolvers<void>();
	const decision = Promise.withResolvers<AccessDecision>();
	const displayed: AccessKind[] = [];
	access.setApprover(async input => {
		displayed.push(input.kind);
		if (input.kind === "tool") {
			entered.resolve();
			return decision.promise;
		}
		return "once";
	});
	const abort = new AbortController();
	const first = access.request(request("tool"), abort.signal).catch((error: unknown) => error);
	await entered.promise;
	abort.abort();
	expect(await first).toBeInstanceOf(Error);
	const next = access.request(request("skill"));
	await Bun.sleep(0);
	expect(displayed).toEqual(["tool"]);
	decision.resolve("run");
	expect(await next).toBe("once");
	expect(displayed).toEqual(["tool", "skill"]);
	expect(access.has("tool", "same", "v1")).toBe(false);
	access.close();
});

for (const invalidation of ["revoke", "policy", "approver", "close"] as const)
	test(`${invalidation} prevents both active and queued stale approvals from creating grants`, async () => {
		const { policy, access } = accessFixture();
		const entered = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<AccessDecision>();
		const displayed: AccessKind[] = [];
		access.setApprover(async input => {
			displayed.push(input.kind);
			entered.resolve();
			return decision.promise;
		});
		const active = access.request(request("tool")).catch((error: unknown) => error);
		await entered.promise;
		const queued = access.request(request("mcp")).catch((error: unknown) => error);
		if (invalidation === "revoke") access.revoke("tool");
		else if (invalidation === "policy") policy.setApprovalMode("full");
		else if (invalidation === "approver") access.setApprover(async () => "run");
		else access.close();
		decision.resolve("run");
		expect(await active).toBeInstanceOf(Error);
		expect(await queued).toBeInstanceOf(Error);
		expect(displayed).toEqual(["tool"]);
		expect(access.has("tool", "same", "v1")).toBe(false);
		expect(access.has("mcp", "same", "v1")).toBe(false);
		access.close();
	});

test("a cancelled queued resource never prompts while a later queued resource can reuse run", async () => {
	const { access } = accessFixture();
	const entered = Promise.withResolvers<void>();
	const decision = Promise.withResolvers<AccessDecision>();
	const displayed: string[] = [];
	access.setApprover(async input => {
		displayed.push(input.key);
		entered.resolve();
		return decision.promise;
	});
	const first = access.request(request("mcp", "read"));
	await entered.promise;
	const abort = new AbortController();
	const cancelled = access.request(request("skill", "cancelled"), abort.signal).catch((error: unknown) => error);
	const next = access.request(request("mcp", "read"));
	abort.abort();
	decision.resolve("run");
	expect(await first).toBe("run");
	expect(await cancelled).toBeInstanceOf(Error);
	expect(await next).toBe("enabled");
	expect(displayed).toEqual(["read"]);
	access.close();
});

test("approval preview and caller mutations cannot change the resource identity receiving a grant", async () => {
	const { access } = accessFixture();
	const entered = Promise.withResolvers<void>();
	const decision = Promise.withResolvers<AccessDecision>();
	access.setApprover(async input => {
		input.kind = "mcp";
		input.key = "unexpected";
		input.fingerprint = "changed";
		entered.resolve();
		return decision.promise;
	});
	const input = request("skill");
	const pending = access.request(input);
	await entered.promise;
	input.key = "mutated";
	decision.resolve("run");
	expect(await pending).toBe("run");
	expect(access.has("skill", "same", "v1")).toBe(true);
	expect(access.has("skill", "mutated", "v1")).toBe(false);
	expect(access.has("mcp", "unexpected", "changed")).toBe(false);
	access.close();
});

test("closed stores reject new grants and requests without exposing saved grants", async () => {
	const { access } = accessFixture();
	access.grant("skill", "same", "v1");
	const signal = access.signal;
	access.close();
	expect(signal.aborted).toBe(true);
	expect(access.signal.aborted).toBe(true);
	expect(access.has("skill", "same", "v1")).toBe(false);
	expect(() => access.grant("tool", "same", "v1")).toThrow();
	await expect(access.request(request("tool"))).rejects.toThrow();
});

test("legacy tool approvers on a shared store leave skill and MCP approval intact", async () => {
	const f = await toolFixture();
	const access = new TemporaryAccess(f.policy);
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const tools = new TemporaryTools(f.state, [writableTool(f.policy)], access);
		const requested: AccessKind[] = [];
		access.setApprover(async input => {
			requested.push(input.kind);
			return "run";
		});
		tools.setApprover(async input => (input.tool === "write" ? "once" : "deny"));
		const target = path.join(f.cwd, "shared.txt");
		await tools.execute(
			"shared",
			{ tool: "write", reason: "兼容工具入口", arguments: { path: target, content: "approved" } },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await Bun.file(target).text()).toBe("approved");
		expect(tools.allows("write")).toBe(false);
		expect(await access.request(request("skill"))).toBe("run");
		expect(await access.request(request("mcp"))).toBe("run");
		expect(requested).toEqual(["skill", "mcp"]);
		tools.revoke();
		expect(access.has("skill", "same", "v1")).toBe(true);
		expect(access.has("mcp", "same", "v1")).toBe(true);
		tools.close();
		expect(access.has("skill", "same", "v1")).toBe(true);
	} finally {
		access.close();
		await f.close();
	}
});

test("tool execution consumes shared grants without exposing another resource kind as a tool grant", async () => {
	const f = await toolFixture();
	const access = new TemporaryAccess(f.policy);
	try {
		f.state.config.resources.disabled = ["tool:write"];
		const tools = new TemporaryTools(f.state, [writableTool(f.policy)], access);
		access.grant("skill", "write", "v1");
		expect(tools.allows("write")).toBe(false);
		access.setApprover(async input => (input.kind === "tool" ? "run" : "deny"));
		const target = path.join(f.cwd, "shared-run.txt");
		await tools.execute(
			"shared-run",
			{ tool: "write", reason: "共用授权存储", arguments: { path: target, content: "approved" } },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await Bun.file(target).text()).toBe("approved");
		expect(access.entries("tool").map(entry => entry.key)).toEqual(["write"]);
		const secondController = new TemporaryTools(f.state, [writableTool(f.policy)], access);
		expect(secondController.allows("write")).toBe(true);
		tools.revoke("write");
		expect(secondController.allows("write")).toBe(false);
		expect(access.has("skill", "write", "v1")).toBe(true);
	} finally {
		access.close();
		await f.close();
	}
});
