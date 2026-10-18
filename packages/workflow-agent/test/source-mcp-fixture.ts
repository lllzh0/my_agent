/** Local real JSON-RPC fixture: no model or external network service. */
export function sourceMcpFixture() {
	let calls = 0;
	const started = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") return new Response(null, { status: 200 });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as {
				id?: string;
				method: string;
				params?: { name?: string; arguments?: { mode?: string; text?: string; token?: string } };
			};
			if (body.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (body.method === "initialize")
				result = {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "source-fixture", version: "1" },
					capabilities: { tools: {} },
				};
			if (body.method === "tools/list")
				result = {
					tools: ["retrieve", "discover", "unknown", "toString"].map(name => ({
						name,
						inputSchema: { type: "object" },
					})),
				};
			if (body.method === "tools/call") {
				calls++;
				const args = body.params?.arguments;
				started.resolve();
				if (args?.mode === "cancel") await Bun.sleep(200);
				if (args?.mode === "throw")
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32000, message: "fixture failed" },
					});
				result = {
					content: [
						{
							type: "text",
							text:
								(args?.text ?? "Actual MCP article evidence") +
								(args?.mode === "large" ? "a".repeat(200_100) : ""),
						},
					],
					structuredContent: { token: args?.token ?? "none", endpoint: request.headers.get("x-echo") ?? "none" },
					...(args?.mode === "error" ? { isError: true, resultId: "forged-server-id" } : {}),
				};
				if (args?.mode === "mixed" || args?.mode === "mixed-attachments" || args?.mode === "structured-large")
					result = {
						content: [
							{ type: "text", text: "Article retrieved." },
							{
								type: "resource",
								resource: { uri: "fixture://article", mimeType: "text/plain", text: "EMBEDDED_FACT_17" },
							},
							...(args.mode === "mixed-attachments"
								? [
										{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
										{
											type: "resource_link",
											uri: "http://127.0.0.1:1/never-fetch",
											name: "Unfetched attachment",
										},
									]
								: []),
						],
						structuredContent: {
							article:
								args.mode === "structured-large"
									? "x".repeat(200_100) + "STRUCTURED_TAIL"
									: "STRUCTURED_FACT_42",
							token: "must-be-redacted",
						},
					};
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		started: started.promise,
		get calls() {
			return calls;
		},
		close: () => server.stop(true),
	};
}
