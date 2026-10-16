import { expect, test } from "bun:test";
import * as path from "node:path";
import { fixture } from "./helpers";

async function persistedSessionId(file: string): Promise<string> {
	const entries = (await Bun.file(file).text())
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
	const id = entries.find(entry => entry.type === "session")?.id;
	if (typeof id !== "string" || !id) throw new Error("The persisted session has no identity");
	return id;
}

test("OpenCode Go requests retain the conversation header across tool calls and resume, and change it for a new conversation", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "reference.txt"), "HEADER_TOOL_REFERENCE");
		f.callTool("read", { path: "reference.txt" });
		const first = await f.run();
		expect(first.code, first.stderr).toBe(0);
		const id = await persistedSessionId(first.result.sessionFile);
		expect(f.requestHeaders.length).toBeGreaterThanOrEqual(2);
		for (const headers of f.requestHeaders) {
			expect(headers.sessionId).toBe(id);
			expect(headers.userAgent).toMatch(/^(?:omp|my-agent)\/\d+\.\d+\.\d+/);
		}

		const beforeResume = f.requestHeaders.length;
		const resumed = await f.run({ resume: first.result.sessionFile });
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(f.requestHeaders.length).toBeGreaterThan(beforeResume);
		for (const headers of f.requestHeaders.slice(beforeResume)) expect(headers.sessionId).toBe(id);

		const beforeNew = f.requestHeaders.length;
		const fresh = await f.run();
		expect(fresh.code, fresh.stderr).toBe(0);
		const nextId = await persistedSessionId(fresh.result.sessionFile);
		expect(nextId).not.toBe(id);
		expect(f.requestHeaders.length).toBeGreaterThan(beforeNew);
		for (const headers of f.requestHeaders.slice(beforeNew)) expect(headers.sessionId).toBe(nextId);
	} finally {
		await f.close();
	}
}, 30000);

test("light OpenCode Go conversations still send a session header and coding-agent user agent", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ light: true });
		expect(run.code, run.stderr).toBe(0);
		const id = await persistedSessionId(run.result.sessionFile);
		expect(f.requestHeaders.length).toBeGreaterThan(0);
		for (const headers of f.requestHeaders) {
			expect(headers.sessionId).toBe(id);
			expect(headers.userAgent).toMatch(/^(?:omp|my-agent)\/\d+\.\d+\.\d+/);
		}
		expect(run.result.tools).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30000);
