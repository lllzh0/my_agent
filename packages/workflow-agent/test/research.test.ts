import assert from "node:assert/strict";
import { test } from "bun:test";
import * as fs from "node:fs/promises";
const { mkdtemp, rm, writeFile } = fs;
import * as path from "node:path";
const { join } = path;
import * as os from "node:os";
const { tmpdir } = os;
import { Research, assertPublicUrl } from "../src/research/research.ts";

test("fetch rejects private addresses and redirect to local service before second request", async () => {
	await assert.rejects(assertPublicUrl("http://127.0.0.1/admin"), /私有|本机/);
	await assert.rejects(assertPublicUrl("http://[::1]/"), /私有|本机/);
	const home = await mkdtemp(join(tmpdir(), "agent-research-"));
	let calls = 0;
	try {
		const research = new Research(
			home,
			{ apiKeyEnv: "NONEXISTENT_TEST_KEY", maxResults: 3 },
			async () => {
				calls++;
				return { status: 302, headers: { location: "http://127.0.0.1/admin" }, body: Buffer.from("") };
			},
			async () => ["93.184.216.34"],
		);
		await assert.rejects(research.fetch("https://example.com/redirect"), /私有|本机/);
		assert.equal(calls, 1);
		assert.equal(research.sources.length, 0);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("research separates search discovery from read evidence and report rejects unsupported sources", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-sources-"));
	process.env.AGENT_TEST_SEARCH = "test-search-credential";
	try {
		const research = new Research(
			home,
			{ apiKeyEnv: "AGENT_TEST_SEARCH", maxResults: 3 },
			async url =>
				url.hostname === "api.tavily.com"
					? {
							status: 200,
							headers: { "content-type": "application/json" },
							body: Buffer.from(
								JSON.stringify({
									results: [{ title: "Candidate", url: "https://example.com/a", content: "Search excerpt" }],
								}),
							),
						}
					: {
							status: 200,
							headers: { "content-type": "text/html" },
							body: Buffer.from(
								"<html><head><title>Evidence</title></head><body><article><p>Verified content for this source with enough text to extract.</p><script>changePermissions()</script></article></body></html>",
							),
						},
			async () => ["93.184.216.34"],
		);
		const found = await research.search("comparison");
		assert.equal(found[0].read, false);
		assert.throws(() => research.report([{ text: "Fact", sourceIds: [found[0].id] }]), /读取/);
		const read = await research.fetch(found[0].url!);
		assert.equal(read.read, true);
		assert.ok(read.text.includes("Verified content"));
		assert.ok(!read.text.includes("changePermissions"));
		assert.ok(research.report([{ text: "Supported", sourceIds: [read.id] }]).includes("https://example.com/a"));
		const restored = new Research(home, { apiKeyEnv: "AGENT_TEST_SEARCH", maxResults: 3 });
		await restored.load();
		assert.equal(restored.sources.filter(x => x.read).length, 1);
	} finally {
		delete process.env.AGENT_TEST_SEARCH;
		await rm(home, { recursive: true, force: true });
	}
});

test("local document keeps text and does not report unknown publication date", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-document-"));
	try {
		const path = join(home, "source.md");
		await writeFile(path, "# Original\nSource facts");
		const research = new Research(home, { apiKeyEnv: "UNSET_TEST_KEY", maxResults: 3 });
		const source = await research.document(path);
		assert.equal(source.read, true);
		assert.equal(source.publishedAt, undefined);
		assert.ok(source.text.includes("Source facts"));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

function samplePdf(text: string): Buffer {
	const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const start = Buffer.byteLength(pdf);
	pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
		.slice(1)
		.map(offset => `${String(offset).padStart(10, "0")} 00000 n `)
		.join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(pdf);
}

test("PDF evidence preserves page number and empty-text PDF is not recorded as read", async () => {
	const home = await mkdtemp(join(tmpdir(), "agent-pdf-"));
	try {
		const path = join(home, "evidence.pdf");
		await writeFile(path, samplePdf("Original PDF evidence"));
		const research = new Research(home, { apiKeyEnv: "UNSET_TEST_KEY", maxResults: 3 });
		const source = await research.document(path);
		assert.equal(source.pages?.[0].page, 1);
		assert.ok(source.text.includes("Original PDF evidence"));
		await writeFile(path, samplePdf(""));
		await assert.rejects(research.document(path), /文本|OCR/);
		assert.equal(research.sources.length, 1);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
