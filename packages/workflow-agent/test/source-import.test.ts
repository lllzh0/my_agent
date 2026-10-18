import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Policy } from "../src/policy/policy";
import { Sandbox } from "../src/processes/sandbox";
import { ManagedMcp } from "../src/mcp/manager";
import { Research } from "../src/research/research";
import { digest } from "../src/storage";
import { sourceMcpFixture } from "./source-mcp-fixture";

const searchConfig = { apiKeyEnv: "UNSET_SOURCE_IMPORT_KEY", maxResults: 3 };

async function setup() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-import-"));
	const remote = sourceMcpFixture();
	const policy = new Policy(root, { readRoots: [], writeRoots: [], allowNetwork: true });
	policy.setApprovalMode("full");
	const research = new Research(path.join(root, "session-a"), searchConfig);
	const mcp = new ManagedMcp(
		{ fixture: { url: remote.url, researchTools: { retrieve: "content", discover: "discovery" } } },
		policy,
		new Sandbox(root, root, []),
		root,
		research.home,
		false,
		research,
	);
	return {
		root,
		remote,
		research,
		mcp,
		async close() {
			await mcp.close();
			await research.close();
			remote.close();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function resultId(output: unknown): string {
	const id = (output as { resultId?: string }).resultId;
	expect(id).toMatch(/^MCP-[a-f0-9-]+$/);
	return id!;
}

test("actual configured MCP content survives restart, late reads, searches and report citations", async () => {
	const f = await setup();
	const reopened = new Research(f.research.home, searchConfig);
	try {
		const id = resultId(await f.mcp.call("fixture", "retrieve", { text: `${"x".repeat(12_000)}LATE_MCP_FACT` }));
		await f.research.close();
		await reopened.load();
		const source = await reopened.importMcpSource(id);
		expect(source.read).toBe(true);
		expect(source.text).not.toContain("LATE_MCP_FACT");
		const tail = (await reopened.readSource(source.id, { offset: 12_001 })).text;
		expect(tail.startsWith("LATE_MCP_FACT")).toBe(true);
		expect(tail).toContain('"endpoint":"none"');
		expect((await reopened.searchSource(source.id, "LATE_MCP_FACT")).matches[0].offset).toBe(12_001);
		expect(reopened.report([{ text: "MCP fact", sourceIds: [source.id] }])).toContain(`[${source.id}]`);
		expect(source.provenance).toMatchObject({
			kind: "mcp",
			resultId: id,
			server: "fixture",
			tool: "retrieve",
			intent: "content",
			authenticity: "unverified",
			truncated: false,
		});
		expect(source.provenance?.argumentsHash).toMatch(/^[a-f0-9]{64}$/);
		expect(source.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect((await reopened.importMcpSource(id)).id).toBe(source.id);
	} finally {
		await reopened.close();
		await f.close();
	}
});

test("discovery cannot become read evidence and unconfigured tools or foreign and forged IDs cannot import", async () => {
	const f = await setup();
	const other = new Research(path.join(f.root, "session-b"), searchConfig);
	try {
		const id = resultId(await f.mcp.call("fixture", "discover", { text: "Search summary only" }));
		const source = await f.research.importMcpSource(id);
		expect(source.read).toBe(false);
		expect(() => f.research.report([{ text: "Unsupported fact", sourceIds: [source.id] }])).toThrow(/读取/);
		await expect(other.importMcpSource(id)).rejects.toThrow(/不存在|当前会话/);
		await expect(f.research.importMcpSource("MCP-forged")).rejects.toThrow(/不存在|当前会话/);
		const unknown = resultId(await f.mcp.call("fixture", "unknown", {}));
		await expect(f.research.importMcpSource(unknown)).rejects.toThrow(/配置|用途/);
		const inherited = resultId(await f.mcp.call("fixture", "toString", {}));
		await expect(f.research.importMcpSource(inherited)).rejects.toThrow(/配置|用途/);
		expect(f.research.stats().sourceCount).toBe(1);
	} finally {
		await other.close();
		await f.close();
	}
});

test("MCP error replies and cancelled or failed calls issue no importable result", async () => {
	const f = await setup();
	try {
		const error = (await f.mcp.call("fixture", "retrieve", { mode: "error" })) as {
			isError?: boolean;
			resultId?: string;
		};
		expect(error.isError).toBe(true);
		expect(error.resultId).toBeUndefined();
		await expect(f.research.importMcpSource("forged-server-id")).rejects.toThrow(/不存在|当前会话/);
		await expect(f.mcp.call("fixture", "retrieve", { mode: "throw" })).rejects.toThrow(/fixture failed/);
		await f.mcp.list("fixture");
		const controller = new AbortController();
		const pending = f.mcp.call("fixture", "retrieve", { mode: "cancel" }, controller.signal);
		await Bun.sleep(30);
		controller.abort();
		await expect(pending).rejects.toThrow(/未知|取消|abort/i);
		expect(f.research.stats().sourceCount).toBe(0);
	} finally {
		await f.close();
	}
});

test("captures redact selected credentials and sensitive fields before durable storage and disclose truncation", async () => {
	const f = await setup();
	const keyName = "SOURCE_IMPORT_SELECTED_CREDENTIAL";
	const previous = process.env[keyName];
	process.env[keyName] = 'local-quote"slash\\secret';
	const selected = new ManagedMcp(
		{
			fixture: {
				url: f.remote.url,
				researchTools: { retrieve: "content" },
				// eslint-disable-next-line no-template-curly-in-string
				headers: { "X-Echo": "${SOURCE_IMPORT_SELECTED_CREDENTIAL}" },
			},
		},
		f.mcp.policy,
		f.mcp.sandbox,
		f.root,
		f.research.home,
		false,
		f.research,
	);
	try {
		const output = await selected.call("fixture", "retrieve", {
			text: `${process.env[keyName]} `,
			mode: "large",
			token: "sensitive-unregistered-value",
		});
		const source = await f.research.importMcpSource(resultId(output));
		expect(source.provenance).toMatchObject({ truncated: true, storedBytes: 200_000 });
		expect(source.coverage).toMatchObject({
			fetchTruncated: true,
			extractionTruncated: true,
			extractedChars: 200_000,
		});
		expect(source.provenance!.originalBytes).toBeGreaterThan(200_000);
		expect(source.text.startsWith("[REDACTED]")).toBe(true);
		const disk = await Bun.file(path.join(f.research.home, "sources.sqlite")).text();
		expect(disk).not.toContain(process.env[keyName]!);
		expect(disk).not.toContain("sensitive-unregistered-value");
		expect(JSON.stringify(output)).not.toContain("sensitive-unregistered-value");
		expect(f.research.report([{ text: "Partial fact", sourceIds: [source.id] }])).toMatch(/未独立验证.*截断/);
	} finally {
		await selected.close();
		if (previous === undefined) delete process.env[keyName];
		else process.env[keyName] = previous;
		await f.close();
	}
});

test("capture quota preserves earlier evidence and reports a completed call without encouraging replay", async () => {
	const f = await setup();
	try {
		let first = "";
		for (let index = 0; index < 1000; index++) {
			const id = await f.research.captureMcpResult({
				server: "fixture",
				tool: "retrieve",
				intent: "content",
				argumentsHash: "a".repeat(64),
				text: "kept evidence",
			});
			if (!index) first = id;
		}
		const output = (await f.mcp.call("fixture", "retrieve", {})) as {
			captureError?: string;
			resultId?: string;
			content: { text: string }[];
		};
		expect(output.captureError).toMatch(/上限/);
		expect(output.resultId).toBeUndefined();
		expect(output.content[0].text).toBe("Actual MCP article evidence");
		expect(f.remote.calls).toBe(1);
		expect((await f.research.importMcpSource(first)).text).toBe("kept evidence");
	} finally {
		await f.close();
	}
});

test("mixed MCP text, embedded text and structured body remain searchable after restart", async () => {
	const f = await setup();
	const reopened = new Research(f.research.home, searchConfig);
	try {
		const id = resultId(await f.mcp.call("fixture", "retrieve", { mode: "mixed" }));
		await f.research.close();
		await reopened.load();
		const source = await reopened.importMcpSource(id);
		const read = await reopened.readSource(source.id);
		expect(read.text).toContain("Article retrieved.");
		expect(read.text).toContain("EMBEDDED_FACT_17");
		expect(read.text).toContain("STRUCTURED_FACT_42");
		expect(read.text).not.toContain("must-be-redacted");
		expect((await reopened.searchSource(source.id, "STRUCTURED_FACT_42")).matches).toHaveLength(1);
		expect(read.coverage.mcp).toEqual({ complete: true, omittedNonTextBlocks: 0 });
	} finally {
		await reopened.close();
		await f.close();
	}
});

test("mixed MCP non-text attachments are disclosed without fetching their links", async () => {
	const f = await setup();
	try {
		const id = resultId(await f.mcp.call("fixture", "retrieve", { mode: "mixed-attachments" }));
		const source = await f.research.importMcpSource(id);
		expect(source.text).toContain("STRUCTURED_FACT_42");
		expect(source.coverage.mcp).toEqual({ complete: false, omittedNonTextBlocks: 2 });
		expect((await f.research.readSource(source.id)).coverage.mcp).toEqual(source.coverage.mcp);
		expect((await f.research.searchSource(source.id, "STRUCTURED_FACT_42")).coverage.mcp).toEqual(
			source.coverage.mcp,
		);
		expect(f.research.report([{ text: "Text evidence only", sourceIds: [source.id] }])).toMatch(/2.*非文本.*未保存/);
		expect(f.remote.calls).toBe(1);
	} finally {
		await f.close();
	}
});

test("combined structured body obeys the capture cap and keeps its full-text hash and truncation", async () => {
	const f = await setup();
	try {
		const id = resultId(await f.mcp.call("fixture", "retrieve", { mode: "structured-large" }));
		const source = await f.research.importMcpSource(id);
		expect(source.coverage.extractedChars).toBe(200_000);
		expect(source.coverage.mcp).toEqual({ complete: false, omittedNonTextBlocks: 0 });
		expect(source.provenance?.truncated).toBe(true);
		expect(source.provenance!.originalChars).toBeGreaterThan(200_000);
		const fullText = `Article retrieved.\nEMBEDDED_FACT_17\n${JSON.stringify({ article: "x".repeat(200_100) + "STRUCTURED_TAIL", token: "[REDACTED]" })}`;
		expect(source.contentHash).toBe(digest(fullText));
		expect((await f.research.searchSource(source.id, "STRUCTURED_TAIL")).matches).toEqual([]);
	} finally {
		await f.close();
	}
});
