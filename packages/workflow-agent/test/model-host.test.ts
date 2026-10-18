import { expect, test } from "bun:test";
import { fixture } from "./helpers";

test("/model switches only explicit endpoints and reports missing credentials without requests", async () => {
	const f = await fixture();
	try {
		f.config.models = [
			{ ...f.config.model, key: "second", name: "Second endpoint" },
			{ ...f.config.model, key: "missing", apiKeyEnv: "ABSENT_PRODUCT_MODEL_KEY" },
		];
		const run = await f.run({
			action: "commands",
			commands: ["/model", "/model second", "/model missing", "/usage"],
			promptAfterCommands: "after-model-switch",
		});
		expect(run.code).toBe(0);
		expect(run.result.displays.find((view: { title: string }) => view.title === "模型连接")).toBeDefined();
		expect(run.result.notifications.join(" ")).toContain("second");
		expect(run.result.notifications.join(" ")).toContain("ABSENT_PRODUCT_MODEL_KEY");
		expect(f.requests.length).toBe(1);
	} finally {
		await f.close();
	}
});

test("extensions cannot select a model connection", async () => {
	const f = await fixture();
	try {
		f.config.models = [{ ...f.config.model, key: "second" }];
		const run = await f.run({ action: "input", command: "/model second", inputSource: "extension" });
		expect(run.code).toBe(0);
		expect(run.result.notifications.join(" ")).toContain("只能由用户");
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
});

for (const scenario of ["pre", "post", "rollback", "transition"] as const)
	test(`native model switch ${scenario} keeps model credentials, effort and grants consistent`, async () => {
		const f = await fixture();
		const second = await fixture();
		try {
			f.config.models = [
				{ ...f.config.model, key: "second", baseUrl: second.config.model.baseUrl, apiKeyEnv: "PRODUCT_TEST_KEY_B" },
			];
			const run = await f.run({
				action: "models",
				modelScenario: scenario,
				promptAfterCommands: "after-transaction",
			});
			expect(run.code, run.stderr).toBe(0);
			const result = run.result.actionResult;
			if (scenario === "transition") {
				expect(result.checks).toHaveLength(11);
				expect(result.checks.every((value: string) => value === "blocked")).toBe(true);
				expect(result.key).toBe("second");
				expect(result.revisionAfter).toBeGreaterThan(result.revisionBefore);
				expect(f.requests).toHaveLength(0);
				expect(second.requests).toHaveLength(1);
				expect(second.requestHeaders[0].authorization).toBe("Bearer fake-second-key");
			} else if (scenario === "rollback") {
				expect(result.failure).toContain("恢复失败");
				expect(result.submissionBlocked).toBe(true);
				expect(f.requests).toHaveLength(0);
				expect(second.requests).toHaveLength(0);
			} else {
				expect(result.failure).toContain("已恢复");
				expect(result.baseUrl).toBe(result.previousBaseUrl);
				expect(result.effort).toBe(result.previousEffort);
				expect(result.credential).toBe("original");
				expect(result.revisionAfter).toBe(result.revisionBefore);
				expect(second.requests).toHaveLength(0);
				expect(f.requests).toHaveLength(1);
			}
		} finally {
			await f.close();
			await second.close();
		}
	}, 20000);

test("model switching rebinds real automatic review to the selected endpoint", async () => {
	const f = await fixture();
	const second = await fixture();
	try {
		f.config.models = [
			{ ...f.config.model, key: "second", baseUrl: second.config.model.baseUrl, apiKeyEnv: "PRODUCT_TEST_KEY_B" },
		];
		second.reviewReply("allow");
		second.callTool("bash", { command: "printf B_REVIEW_APPROVED" });
		const run = await f.run({
			action: "commands",
			commands: ["/permissions auto", "/model second"],
			promptAfterCommands: "Print B_REVIEW_APPROVED",
		});
		expect(run.code, run.stderr).toBe(0);
		expect(f.requests).toHaveLength(0);
		expect(second.requestHeaders.some(header => header.sessionId?.endsWith(":review"))).toBe(true);
		expect(second.requestHeaders.every(header => header.authorization === "Bearer fake-second-key")).toBe(true);
		expect(run.result.automaticReview.requests).toBeGreaterThan(0);
	} finally {
		await f.close();
		await second.close();
	}
}, 20000);

test("explicit custom model preserves wire id and uses only the configured localhost route", async () => {
	const f = await fixture();
	try {
		f.config.model = {
			...f.config.model,
			provider: "product-local-fixture",
			input: ["text"],
			id: "custom-wire-id",
			api: "openai-completions",
			contextWindow: 32000,
			maxTokens: 4096,
		};
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].model).toBe("custom-wire-id");
		expect(f.requestHeaders[0].authorization).toBe("Bearer fake-local-key");
		expect(JSON.stringify(run.result.messages)).toContain("LOCAL_PRODUCT_OK");
	} finally {
		await f.close();
	}
});
