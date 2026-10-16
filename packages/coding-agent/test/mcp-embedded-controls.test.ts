import { expect, test } from "bun:test";
import { StdioTransport } from "../src/mcp/transports/stdio";
import { HttpTransport } from "../src/mcp/transports/http";

test("embedded stdio can opt out of inherited environment and close its process group", async () => {
	const previous = process.env.MCP_EMBEDDED_TEST_SECRET;
	process.env.MCP_EMBEDDED_TEST_SECRET = "parent-only-fixture";
	const transport = new StdioTransport(
		{
			command: process.execPath,
			args: [
				"-e",
				`const child = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
for await (const line of console) {
 const request = JSON.parse(line);
 console.log(JSON.stringify({jsonrpc: "2.0", id: request.id, result: {
  inherited: Boolean(process.env.MCP_EMBEDDED_TEST_SECRET), selected: process.env.SELECTED,
  pid: process.pid, child: child.pid
 }}));
}`,
			],
			env: { SELECTED: "explicit-fixture" },
		},
		{ inheritEnv: false, detached: true },
	);
	let child: number | undefined;
	try {
		await transport.connect();
		const probe = await transport.request<{ inherited: boolean; selected: string; pid: number; child: number }>(
			"probe",
		);
		child = probe.child;
		expect(probe.inherited).toBe(false);
		expect(probe.selected).toBe("explicit-fixture");
		await transport.close();
		expect(() => process.kill(probe.pid, 0)).toThrow();
		await Bun.sleep(30);
		expect(() => process.kill(probe.child, 0)).toThrow();
	} finally {
		await transport.close();
		if (child) {
			try {
				process.kill(child, "SIGKILL");
			} catch {
				/* Already gone. */
			}
		}
		if (previous === undefined) delete process.env.MCP_EMBEDDED_TEST_SECRET;
		else process.env.MCP_EMBEDDED_TEST_SECRET = previous;
	}
});

test("embedded stdio does not spawn after cancellation", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancelled-before-spawn"));
	const transport = new StdioTransport({ command: "/bin/sleep", args: ["60"] }, { signal: controller.signal });
	try {
		await expect(transport.connect()).rejects.toThrow("cancelled-before-spawn");
	} finally {
		await transport.close();
	}
});

test("concurrent stdio close callers both wait for process termination", async () => {
	let first: Promise<void> | undefined;
	let reentrant: Promise<void> | undefined;
	const transport = new StdioTransport(
		{
			command: process.execPath,
			args: [
				"-e",
				`
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
for await (const line of console) {
 if (!line.trim()) continue;
 const request = JSON.parse(line);
 console.log(JSON.stringify({jsonrpc:"2.0", id:request.id, result:{pid:process.pid}}));
}`,
			],
		},
		{ detached: true },
	);
	try {
		await transport.connect();
		const { pid } = await transport.request<{ pid: number }>("probe");
		transport.onClose = () => {
			reentrant = transport.close();
		};
		first = transport.close();
		await transport.close();
		expect(() => process.kill(pid, 0)).toThrow();
		await first;
	} finally {
		await first;
		await reentrant;
		await transport.close();
	}
});

test("an embedder can collect startup stderr without writing it into the terminal", async () => {
	let diagnostic = "";
	const transport = new StdioTransport(
		{
			command: process.execPath,
			args: ["-e", "process.stderr.write('fixture-startup-diagnostic'); setTimeout(() => process.exit(1), 100)"],
		},
		{
			onStderr: text => {
				diagnostic += text;
			},
		},
	);
	try {
		await transport.connect();
		await expect(transport.request("initialize")).rejects.toThrow();
		expect(diagnostic).toContain("fixture-startup-diagnostic");
	} finally {
		await transport.close();
	}
});

test("same-origin MCP policy never sends the request body to a redirect destination", async () => {
	let forwarded = 0;
	const target = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			forwarded++;
			const body = (await request.json()) as { id: string };
			return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
		},
	});
	const origin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/` } }),
	});
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${origin.port}/`,
		redirectPolicy: "same-origin",
	});
	try {
		await transport.connect();
		await expect(
			transport.request("tools/call", { name: "write", arguments: { text: "private-fixture" } }),
		).rejects.toThrow("origin");
		expect(forwarded).toBe(0);
	} finally {
		await transport.close();
		origin.stop(true);
		target.stop(true);
	}
});

test("an explicit HTTP shutdown deadline survives a disabled global MCP timeout", async () => {
	const previous = process.env.OMP_MCP_TIMEOUT_MS;
	process.env.OMP_MCP_TIMEOUT_MS = "0";
	const deleteResponse = Promise.withResolvers<Response>();
	const deleting = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				deleting.resolve();
				return deleteResponse.promise;
			}
			const body = (await request.json()) as { id: string };
			return Response.json(
				{ jsonrpc: "2.0", id: body.id, result: {} },
				{ headers: { "Mcp-Session-Id": "deadline-fixture" } },
			);
		},
	});
	const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/`, shutdownTimeout: 50 });
	let closing: Promise<void> | undefined;
	try {
		await transport.connect();
		await transport.request("initialize");
		let closed = false;
		closing = transport.close().then(() => {
			closed = true;
		});
		await deleting.promise;
		await Bun.sleep(200);
		expect(closed).toBe(true);
	} finally {
		deleteResponse.resolve(new Response(null, { status: 200 }));
		await closing;
		await transport.close();
		server.stop(true);
		if (previous === undefined) delete process.env.OMP_MCP_TIMEOUT_MS;
		else process.env.OMP_MCP_TIMEOUT_MS = previous;
	}
});
