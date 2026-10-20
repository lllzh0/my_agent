import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { fixture } from "./helpers";

test.each([false, true])(
	"per-message TPS and TTFT are displayed by default (light=%s) and survive resume without another model request",
	async light => {
		const f = await fixture();
		try {
			f.respond(() => ({
				text: "METRICS_RESPONSE",
				delayMs: 200,
				usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
			}));
			const first = await f.run({ action: "message-metrics", light });
			expect(first.code, first.stderr).toBe(0);
			const messages = first.result.messages as { role: string }[];
			const response = messages.find(message => message.role === "assistant") as AssistantMessage;
			const rendered = first.result.actionResult.rendered as string;
			expect(response.ttft).toBeGreaterThan(100);
			expect(response.duration).toBeGreaterThan(100);
			expect(rendered).toContain(`${(80 / (response.duration! / 1000)).toFixed(1)}/s`);
			expect(rendered).toContain(`${(response.ttft! / 1000).toFixed(1)}s`);
			const resumed = await f.run({ action: "message-metrics", light, resume: first.result.sessionFile });
			expect(resumed.code, resumed.stderr).toBe(0);
			expect(resumed.result.actionResult.rendered).toBe(rendered);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
	30000,
);

test("tool-call and final responses keep separate message rates rather than a whole-task average", async () => {
	const f = await fixture();
	try {
		f.respond(body =>
			body.messages.some(message => message.role === "tool")
				? {
						text: "METRICS_FINAL",
						delayMs: 200,
						usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
					}
				: {
						call: { name: "find", arguments: { pattern: "*.ts" } },
						delayMs: 200,
						usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
					},
		);
		const run = await f.run({ action: "message-metrics" });
		expect(run.code, run.stderr).toBe(0);
		const messages = (run.result.messages as AssistantMessage[]).filter(message => message.role === "assistant");
		expect(messages).toHaveLength(2);
		const rendered = run.result.actionResult.rendered as string;
		for (const message of messages) {
			expect(rendered).toContain(`${(message.usage.output / (message.duration! / 1000)).toFixed(1)}/s`);
			expect(rendered).toContain(`${(message.ttft! / 1000).toFixed(1)}s`);
		}
		expect(rendered.match(/\d+(?:\.\d+)?\/s/g)).toHaveLength(2);
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30000);

test("missing provider usage does not invent zero or infinite TPS", async () => {
	const f = await fixture();
	try {
		f.respond(() => ({ text: "USAGE_UNAVAILABLE", delayMs: 150 }));
		const run = await f.run({ action: "message-metrics" });
		expect(run.code, run.stderr).toBe(0);
		const rendered = run.result.actionResult.rendered as string;
		expect(rendered).toContain("USAGE_UNAVAILABLE");
		expect(rendered).not.toMatch(/(?:NaN|Infinity|\d+(?:\.\d+)?)\/s/);
		expect(f.requests).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30000);
