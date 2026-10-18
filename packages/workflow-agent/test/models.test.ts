import { describe, expect, test } from "bun:test";
import { defaultConfig, validateConfig } from "../src/config/config";

describe("explicit model configuration", () => {
	test("rejects duplicate connection keys instead of silently replacing endpoints", () => {
		const config = defaultConfig();
		const input = { ...config, models: [{ ...config.model, baseUrl: "http://127.0.0.1:4321/v1" }] };
		expect(() => validateConfig(input)).toThrow("重复");
	});
	test("validates extra connection credentials and metadata", () => {
		for (const extra of [
			{ apiKeyEnv: "!read-secret" },
			{ apiKey: "inline-secret" },
			{ maxTokens: -1 },
			{ api: "not-an-api" },
			{ input: ["video"] },
			{ thinking: { mode: "effort", efforts: ["unknown"] } },
		]) {
			const config = defaultConfig();
			expect(() => validateConfig({ ...config, models: [{ ...config.model, key: "extra", ...extra }] })).toThrow();
		}
	});
});

test("legacy configuration remains valid while malformed metadata cannot enter bindings", () => {
	expect(validateConfig(defaultConfig()).models).toBeUndefined();
	for (const extra of [
		{ thinking: { mode: "effort", efforts: [] } },
		{ thinking: { mode: "effort", efforts: ["high", "low"] } },
		{ thinking: { mode: "effort", efforts: ["low"], defaultLevel: "high" } },
		{ contextWindow: 12, maxTokens: 20 },
		{ baseUrl: "https://user:secret@example.com/v1" },
		{ baseUrl: "https://example.com/v1?key=secret" },
	])
		expect(() =>
			validateConfig({ ...defaultConfig(), models: [{ ...defaultConfig().model, key: "extra", ...extra }] }),
		).toThrow();
});
