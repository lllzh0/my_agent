import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Research } from "../src/research/research";

const config = { apiKeyEnv: "UNSET_SOURCE_READING_TEST_KEY", maxResults: 3 };

test("long sources remain readable past the first model excerpt and reject invalid ranges", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-ranges-"));
	const research = new Research(root, config);
	try {
		const file = path.join(root, "long.txt");
		await Bun.write(file, `${"x".repeat(12_000)}TAIL_EVIDENCE${"y".repeat(100)}`);
		const source = await research.document(file);
		expect(source.text).not.toContain("TAIL_EVIDENCE");
		expect(source.range.nextOffset).toBe(12_001);
		const read = await research.readSource(source.id, { offset: 12_001, limit: 13 });
		expect(read.text).toBe("TAIL_EVIDENCE");
		expect(read.range).toMatchObject({ offset: 12_001, end: 12_013, totalChars: 12_113, nextOffset: 12_014 });
		expect(read.coverage.extractionTruncated).toBe(false);
		await expect(research.readSource(source.id, { offset: 0 })).rejects.toThrow(/offset|范围/);
		await expect(research.readSource(source.id, { offset: 12_115 })).rejects.toThrow(/范围/);
		await expect(research.readSource(source.id, { limit: 12_001 })).rejects.toThrow(/limit|范围/);
		await expect(research.readSource(source.id, { page: 1 })).rejects.toThrow(/PDF/);
	} finally {
		await research.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("real text beyond the old 40000-character cap remains readable and searchable", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-long-evidence-"));
	const research = new Research(root, config);
	try {
		const file = path.join(root, "long.txt");
		await Bun.write(file, `${"x".repeat(60_000)}LATE_EVIDENCE`);
		const source = await research.document(file);
		expect((await research.readSource(source.id, { offset: 60_001 })).text).toBe("LATE_EVIDENCE");
		expect((await research.searchSource(source.id, "LATE_EVIDENCE")).matches[0].offset).toBe(60_001);
		expect(source.coverage.extractionTruncated).toBe(false);
	} finally {
		await research.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("more than 200 sources keep old citations usable without growing the recent list", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-retention-"));
	const research = new Research(root, config);
	try {
		let first = "";
		for (let index = 0; index < 205; index++) {
			const file = path.join(root, `source-${index}.txt`);
			await Bun.write(file, "shared source evidence");
			const source = await research.document(file);
			if (index === 0) first = source.id;
		}
		expect(research.sources.length).toBeLessThanOrEqual(50);
		expect(research.sources.some(source => source.id === first)).toBe(false);
		expect(research.report([{ text: "An old cited fact", sourceIds: [first] }])).toContain(`[${first}]`);
		expect((await research.readSource(first)).text).toBe("shared source evidence");
		expect(research.stats()).toMatchObject({ sourceCount: 205, contentCount: 1 });
		expect(research.stats().databaseBytes).toBeGreaterThan(0);
	} finally {
		await research.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("unchanged source content deduplicates while changed versions and old IDs survive reopening", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-versions-"));
	const research = new Research(root, config);
	const reopened = new Research(root, config);
	try {
		const file = path.join(root, "source.txt");
		await Bun.write(file, "original fact");
		const first = await research.document(file);
		expect((await research.document(file)).id).toBe(first.id);
		await Bun.write(file, "corrected fact");
		const changed = await research.document(file);
		expect(changed.id).not.toBe(first.id);
		expect((await research.readSource(first.id)).text).toBe("original fact");
		await research.close();
		await reopened.load();
		expect((await reopened.readSource(first.id)).text).toBe("original fact");
		expect((await reopened.document(file)).id).toBe(changed.id);
		expect(reopened.stats()).toMatchObject({ sourceCount: 2, contentCount: 2 });
		await expect(research.readSource(first.id)).rejects.toThrow(/关闭/);
	} finally {
		await research.close?.();
		await reopened.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("legacy JSON migrates once without changing original evidence or reusing issued IDs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-migrate-"));
	const research = new Research(root, config);
	const reopened = new Research(root, config);
	try {
		const legacy = JSON.stringify([
			{
				id: "S7",
				title: "Old evidence",
				path: "/old/source.txt",
				retrievedAt: "2025-01-01T00:00:00Z",
				read: true,
				text: "kept fact",
			},
			{
				id: "S19",
				title: "Search only",
				url: "https://example.com",
				retrievedAt: "2025-01-01T00:00:00Z",
				read: false,
				text: "snippet",
			},
		]);
		const jsonFile = path.join(root, "sources.json");
		await Bun.write(jsonFile, legacy);
		await research.load();
		expect((await research.readSource("S7")).text).toBe("kept fact");
		expect((await research.readSource("S7")).coverage.extractionTruncated).toBeNull();
		expect(() => research.report([{ text: "Unverified fact", sourceIds: ["S19"] }])).toThrow(/读取/);
		const file = path.join(root, "fresh.txt");
		await Bun.write(file, "new evidence");
		expect((await research.document(file)).id).toBe("S20");
		await research.close();
		await reopened.load();
		expect(reopened.stats().sourceCount).toBe(3);
		expect(await Bun.file(jsonFile).text()).toBe(legacy);
	} finally {
		await research.close?.();
		await reopened.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("concurrent readers import legacy sources once and share the next stable ID", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-migrate-concurrent-"));
	const first = new Research(root, config);
	const second = new Research(root, config);
	try {
		const legacy = JSON.stringify([
			{ id: "S7", title: "Old evidence", retrievedAt: "2025-01-01T00:00:00Z", read: true, text: "kept fact" },
		]);
		const jsonFile = path.join(root, "sources.json");
		await Bun.write(jsonFile, legacy);
		await Promise.all([first.load(), second.load()]);
		expect((await first.readSource("S7")).text).toBe("kept fact");
		expect((await second.readSource("S7")).text).toBe("kept fact");
		const fresh = path.join(root, "fresh.txt");
		await Bun.write(fresh, "new evidence");
		expect((await first.document(fresh)).id).toBe("S8");
		expect((await second.document(fresh)).id).toBe("S8");
		expect(second.stats().sourceCount).toBe(2);
		expect(await Bun.file(jsonFile).text()).toBe(legacy);
	} finally {
		await Promise.all([first.close(), second.close()]);
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("invalid legacy rows roll back the whole migration and allow a corrected retry", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-migrate-fail-"));
	const research = new Research(root, config);
	const retry = new Research(root, config);
	try {
		const valid = { id: "S1", title: "Evidence", retrievedAt: "2025-01-01T00:00:00Z", read: true, text: "kept" };
		const original = JSON.stringify([valid, { ...valid, id: "S2", text: 42 }]);
		await Bun.write(path.join(root, "sources.json"), original);
		await expect(research.load()).rejects.toThrow(/来源|迁移/);
		expect(await Bun.file(path.join(root, "sources.json")).text()).toBe(original);
		await research.close?.();
		await Bun.write(path.join(root, "sources.json"), JSON.stringify([valid]));
		await retry.load();
		expect(retry.stats()).toMatchObject({ sourceCount: 1, contentCount: 1 });
	} finally {
		await research.close?.();
		await retry.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("literal source search paginates without omissions and cancellation stores no fetched evidence", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-search-"));
	const controller = new AbortController();
	const research = new Research(
		root,
		config,
		async () => {
			controller.abort();
			return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("must not be saved") };
		},
		async () => ["93.184.216.34"],
	);
	try {
		const file = path.join(root, "source.txt");
		await Bun.write(file, "a.b A.B aXb a.b");
		const source = await research.document(file);
		const first = await research.searchSource(source.id, "a.b", { limit: 1, ignoreCase: true });
		expect(first.matches.map(match => match.offset)).toEqual([1]);
		expect(first.complete).toBe(false);
		expect(first.nextOffset).toBe(5);
		const second = await research.searchSource(source.id, "a.b", { offset: first.nextOffset, ignoreCase: true });
		expect(second.matches.map(match => match.offset)).toEqual([5, 13]);
		expect(second.complete).toBe(true);
		await expect(research.searchSource(source.id, "")).rejects.toThrow(/非空|查询/);
		await expect(research.fetch("https://example.com/cancel", controller.signal)).rejects.toThrow(/取消/);
		expect(research.stats().sourceCount).toBe(1);
		await expect(research.readSource(source.id, { signal: controller.signal })).rejects.toThrow(/取消/);
		await expect(research.searchSource(source.id, "a.b", { signal: controller.signal })).rejects.toThrow(/取消/);
	} finally {
		await research.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("fetch byte limits, extraction limits and returned ranges are separate", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-coverage-"));
	let body = Buffer.from("a".repeat(2_000_040));
	const research = new Research(
		root,
		config,
		async () => ({ status: 200, headers: { "content-type": "text/plain" }, body }),
		async () => ["93.184.216.34"],
	);
	try {
		const source = await research.fetch("https://example.com/large");
		expect(source.coverage).toMatchObject({
			fetchedBytes: 2_000_040,
			fetchTruncated: false,
			extractedChars: 2_000_000,
			totalChars: 2_000_040,
			extractionTruncated: true,
		});
		expect(source.range).toMatchObject({ totalChars: 2_000_000, end: 12_000, nextOffset: 12_001 });
		const last = await research.readSource(source.id, { offset: 1_999_991 });
		expect(last.text).toHaveLength(10);
		expect(last.range.nextOffset).toBeUndefined();
		expect(last.coverage.extractionTruncated).toBe(true);
		body = Buffer.from(`${"a".repeat(2_000_039)}b`);
		const changedTail = await research.fetch("https://example.com/large");
		expect(changedTail.id).not.toBe(source.id);
		expect((await research.readSource(source.id)).coverage.fetchedBytes).toBe(2_000_040);
		body = Buffer.alloc(5_000_001, 97);
		await expect(research.fetch("https://example.com/too-large")).rejects.toThrow(/5MB/);
		expect(research.stats().sourceCount).toBe(2);
	} finally {
		await research.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Unicode literal search advances across surrogate pairs without duplicate or backward matches", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-unicode-"));
	const research = new Research(root, config);
	try {
		const file = path.join(root, "unicode.txt");
		await Bun.write(file, "😀 x 😀");
		const source = await research.document(file);
		expect((await research.searchSource(source.id, "😀")).matches.map(match => match.offset)).toEqual([1, 6]);
		expect((await research.searchSource(source.id, "😀", { offset: 2 })).matches.map(match => match.offset)).toEqual([
			6,
		]);
	} finally {
		await research.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

function pagesPdf(texts: string[]): Buffer {
	const pageIds = texts.map((_text, index) => 4 + index * 2);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${texts.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const [index, text] of texts.entries()) {
		const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
			`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		);
	}
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const start = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map(offset => `${String(offset).padStart(10, "0")} 00000 n `)
		.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(pdf);
}

test("PDF page reads and searches retain original page numbers and explain unextracted pages", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-pages-"));
	const research = new Research(root, config);
	try {
		const file = path.join(root, "pages.pdf");
		await Bun.write(file, pagesPdf(Array.from({ length: 202 }, (_item, index) => `EVIDENCE page ${index + 1}`)));
		const source = await research.document(file);
		expect(source.coverage).toMatchObject({ totalPages: 202, extractedPages: 200, extractionTruncated: true });
		const page = await research.readSource(source.id, { page: 2, limit: 8 });
		expect(page.text).toBe("EVIDENCE");
		expect(page.range).toMatchObject({ page: 2, offset: 1, end: 8, nextOffset: 9 });
		const rest = await research.readSource(source.id, { page: 2, offset: 9 });
		expect(rest.text).toBe(" page 2");
		expect(rest.range.nextPage).toBe(3);
		const matches = await research.searchSource(source.id, "page 2", { page: 2 });
		expect(matches.matches).toMatchObject([{ page: 2, offset: 10 }]);
		const wholePdf = await research.searchSource(source.id, "EVIDENCE page 50");
		expect(wholePdf.matches[0]).toMatchObject({ page: 50, pageOffset: 1 });
		expect(
			(
				await research.readSource(source.id, {
					page: wholePdf.matches[0].page,
					offset: wholePdf.matches[0].pageOffset,
				})
			).text,
		).toBe("EVIDENCE page 50");
		expect(source.pages?.[0].range).toMatchObject({ page: 1, offset: 1, totalChars: 15 });
		expect((await research.readSource(source.id, { page: 50 })).text).toBe("EVIDENCE page 50");
		await expect(research.readSource(source.id, { page: 201 })).rejects.toThrow(/提取/);
		await expect(research.readSource(source.id, { page: 203 })).rejects.toThrow(/页码/);
	} finally {
		await research.close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});
