import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { FetchImpl, Model } from "../src/types";

test("OpenCode Go uses the current bundled endpoint while respecting an explicit endpoint override", async () => {
	const bundled = getBundledModel("opencode-go", "deepseek-v4.1-flash") as Model<"openai-completions">;
	const urls: string[] = [];
	const fetchMock: FetchImpl = Object.assign(
		async (input: string | URL | Request) => {
			urls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		{ preconnect: fetch.preconnect },
	);
	for (const model of [bundled, { ...bundled, baseUrl: "https://chosen.invalid/v1" }]) {
		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "endpoint probe", timestamp: 0 }] },
			{ apiKey: "offline-endpoint-fixture", fetch: fetchMock },
		).result();
		expect(result.stopReason).toBe("stop");
	}
	expect(urls).toEqual([
		"https://opencode.ai/inference/go/v1/chat/completions",
		"https://chosen.invalid/v1/chat/completions",
	]);
});
