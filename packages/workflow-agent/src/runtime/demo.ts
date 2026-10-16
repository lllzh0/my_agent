import reply from "../prompts/demo.md" with { type: "text" };

export function startDemo() {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unknown path", { status: 404 });
			const input = (await request.json()) as { model: string };
			const base = { id: "offline", object: "chat.completion.chunk", created: 1, model: input.model };
			const frames = [
				{
					...base,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", reasoning_content: "", content: reply },
							finish_reason: null,
						},
					],
				},
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
			return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
}
