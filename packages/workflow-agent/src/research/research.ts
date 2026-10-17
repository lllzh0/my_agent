import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import * as fs from "node:fs/promises";
const { readFile, stat } = fs;
import * as path from "node:path";
const { basename, extname, join, dirname, sep } = path;
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { digest } from "../storage";
import { SourceStore } from "./store";
import {
	type Source,
	type StoredSource,
	type SourceInfo,
	type SourceCoverage,
	type SourceBody,
	type SourceReadOptions,
	type SourceReadResult,
	type SourceSearchOptions,
	type SourceSearchResult,
	type ResearchStats,
	SOURCE_LIMITS,
	SOURCE_READ_LIMIT,
} from "./types";
export * from "./types";
export interface HttpResult {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}
export type Resolver = (hostname: string) => Promise<string[]>;
export type Transport = (url: URL, addresses: string[], body?: string, signal?: AbortSignal) => Promise<HttpResult>;
const dnsResolve: Resolver = async hostname => (await lookup(hostname, { all: true })).map(x => x.address);

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("资料读取已取消");
}

function textCoverage(text: string, acquisition: SourceCoverage["acquisition"], bytes: number): SourceCoverage {
	return {
		acquisition,
		fetchedBytes: bytes,
		fetchTruncated: false,
		extractedChars: Math.min(text.length, SOURCE_LIMITS.extractionChars),
		totalChars: text.length,
		extractionTruncated: text.length > SOURCE_LIMITS.extractionChars,
		limits: { ...SOURCE_LIMITS },
	};
}

function sourceInfo(source: StoredSource): SourceInfo {
	const { text: _text, pages: _pages, ...info } = source;
	return info;
}

function sourceText(source: StoredSource, page?: number): string {
	if (page === undefined) return source.text;
	if (!source.pages) throw new Error("只有 PDF 来源支持 page 页码");
	if (
		!Number.isInteger(page) ||
		page < 1 ||
		(source.coverage.totalPages !== undefined && page > source.coverage.totalPages)
	)
		throw new Error("PDF 页码超出有效范围");
	const selected = source.pages.find(item => item.page === page);
	if (!selected) throw new Error("此页未提取：来源达到解析上限或旧记录没有保留该页");
	return selected.text;
}

function rangeOffset(offset: number | undefined, length: number): number {
	const value = offset ?? 1;
	if (!Number.isSafeInteger(value) || value < 1 || value > length + 1) throw new Error("offset 超出已提取正文范围");
	return value;
}

function readWindow(source: StoredSource, options: SourceReadOptions = {}): SourceReadResult {
	checkAbort(options.signal);
	const body = sourceText(source, options.page);
	const offset = rangeOffset(options.offset, body.length);
	const limit = options.limit ?? SOURCE_READ_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_READ_LIMIT) throw new Error("limit 范围为 1–12000");
	const text = body.slice(offset - 1, offset - 1 + limit);
	const end = offset - 1 + text.length;
	const nextPage =
		options.page !== undefined ? source.pages?.find(page => page.page > options.page!)?.page : undefined;
	return {
		...sourceInfo(source),
		text,
		range: {
			offset,
			end,
			totalChars: body.length,
			...(options.page !== undefined ? { page: options.page } : {}),
			...(end < body.length ? { nextOffset: end + 1 } : nextPage !== undefined ? { nextPage } : {}),
			truncated: offset > 1 || end < body.length,
		},
	};
}

function preview(source: StoredSource): Source {
	return {
		...readWindow(source),
		...(source.pages
			? {
					pages: source.pages.slice(0, 3).map(page => {
						const preview = readWindow(source, { page: page.page, limit: 500 });
						return { page: page.page, text: preview.text, range: preview.range };
					}),
				}
			: {}),
	};
}

function privateAddress(address: string): boolean {
	if (isIP(address) === 6) return !/^[23]/.test(address) || address.toLowerCase().startsWith("2001:db8:");
	const [a, b] = address.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 169 && b === 254) ||
		(a === 192 && [0, 168].includes(b)) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 198 && [18, 19].includes(b))
	);
}

export async function assertPublicUrl(
	value: string,
	resolver: Resolver = dnsResolve,
): Promise<{ url: URL; addresses: string[] }> {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("只支持无内嵌凭据的 HTTP(S) 资料地址");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (/^(?:localhost|.*\.localhost)$/i.test(hostname)) throw new Error("不能访问本机或私有网络资料地址");
	const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
	if (!addresses.length || addresses.some(address => !isIP(address) || privateAddress(address)))
		throw new Error("不能访问本机或私有网络资料地址");
	return { url, addresses };
}

const transport: Transport = (url, addresses, body, signal) => {
	const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	const req = request(
		url,
		{
			method: body === undefined ? "GET" : "POST",
			signal,
			headers: {
				"user-agent": "MyWorkflowAgent/0.1",
				accept: "text/html,application/json,application/pdf,text/plain",
				"accept-encoding": "identity",
				...(body === undefined
					? {}
					: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
			},
			lookup: (_hostname, options, callback) => {
				const entries = addresses.map(address => ({ address, family: isIP(address) }));
				if (options.all) callback(null, entries);
				else callback(null, entries[0].address, entries[0].family);
			},
		},
		response => {
			let size = 0;
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > SOURCE_LIMITS.fetchBytes) req.destroy(new Error("资料超过 5MB 上限"));
				else chunks.push(chunk);
			});
			response.on("error", reject);
			response.on("end", () =>
				resolve({
					status: response.statusCode ?? 0,
					headers: Object.fromEntries(
						Object.entries(response.headers).map(([key, value]) => [
							key,
							Array.isArray(value) ? value.join(", ") : (value ?? ""),
						]),
					),
					body: Buffer.concat(chunks),
				}),
			);
		},
	);
	req.setTimeout(15_000, () => req.destroy(new Error("资料读取超时")));
	req.on("error", reject);
	req.end(body);
	return promise;
};

export class Research {
	readonly home: string;
	readonly config: { apiKeyEnv: string; maxResults: number };
	readonly sources: Source[] = [];
	#send: Transport;
	#resolver: Resolver;
	#store?: SourceStore;
	#opening?: Promise<SourceStore>;
	#closing?: Promise<void>;
	#closed = false;
	constructor(
		home: string,
		config: { apiKeyEnv: string; maxResults: number },
		send: Transport = transport,
		resolver: Resolver = dnsResolve,
	) {
		this.home = home;
		this.config = config;
		this.#send = send;
		this.#resolver = resolver;
	}
	async load(): Promise<void> {
		await this.#ensureStore();
	}
	async #ensureStore(): Promise<SourceStore> {
		if (this.#closed) throw new Error("资料存储已关闭");
		this.#opening ??= SourceStore.open(this.home).then(store => {
			this.#store = store;
			this.sources.splice(0, this.sources.length, ...store.recent());
			return store;
		});
		const store = await this.#opening;
		if (this.#closed) throw new Error("资料存储已关闭");
		return store;
	}
	async #add(source: Omit<StoredSource, "id" | "retrievedAt">, signal?: AbortSignal): Promise<Source> {
		checkAbort(signal);
		const store = await this.#ensureStore();
		checkAbort(signal);
		const saved = store.add(source);
		this.sources.splice(0, this.sources.length, ...store.recent());
		return preview(saved);
	}
	async readSource(id: string, options: SourceReadOptions = {}): Promise<SourceReadResult> {
		checkAbort(options.signal);
		const source = (await this.#ensureStore()).get(id);
		if (!source) throw new Error(`来源 ${id} 不存在`);
		return readWindow(source, options);
	}
	async searchSource(id: string, query: string, options: SourceSearchOptions = {}): Promise<SourceSearchResult> {
		checkAbort(options.signal);
		if (!query.trim() || query.length > 1000) throw new Error("来源查询须为非空字面文本，最长 1000 字符");
		const source = (await this.#ensureStore()).get(id);
		if (!source) throw new Error(`来源 ${id} 不存在`);
		const body = sourceText(source, options.page);
		let cursor = rangeOffset(options.offset, body.length) - 1;
		const limit = options.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("检索 limit 范围为 1–100");
		const matches: SourceSearchResult["matches"] = [];
		// Escaping makes the query literal; Unicode /i keeps original UTF-16 offsets
		// even when lowercasing would change a character's length (for example İ).
		const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.ignoreCase ? "giu" : "gu");
		let nextOffset: number | undefined;
		while (cursor <= body.length) {
			checkAbort(options.signal);
			expression.lastIndex = cursor;
			const found = expression.exec(body);
			if (!found) break;
			if (matches.length === limit) {
				nextOffset = found.index + 1;
				break;
			}
			let page = options.page;
			let pageOffset = page !== undefined ? found.index + 1 : undefined;
			if (page === undefined && source.pages) {
				let start = 0;
				for (const entry of source.pages) {
					const contentStart = start + `[第 ${entry.page} 页] `.length;
					const end = contentStart + entry.text.length;
					if (found.index < end) {
						page = entry.page;
						if (found.index >= contentStart) pageOffset = found.index - contentStart + 1;
						break;
					}
					start = end + 1;
				}
			}
			matches.push({
				offset: found.index + 1,
				end: found.index + found[0].length,
				...(page !== undefined ? { page } : {}),
				...(pageOffset !== undefined ? { pageOffset } : {}),
				excerpt: body.slice(Math.max(0, found.index - 80), found.index + found[0].length + 120),
			});
			cursor = found.index + 1;
		}
		return {
			...sourceInfo(source),
			query,
			matches,
			...(options.page !== undefined ? { page: options.page } : {}),
			...(nextOffset !== undefined ? { nextOffset } : {}),
			complete: nextOffset === undefined,
		};
	}
	stats(): ResearchStats {
		return (
			this.#store?.stats() ?? { sourceCount: 0, contentCount: 0, contentBytes: 0, databaseBytes: 0, recentCount: 0 }
		);
	}
	close(): Promise<void> {
		this.#closing ??= (async () => {
			this.#closed = true;
			try {
				await this.#opening;
			} catch {
				/* Failed open already closes its database. */
			}
			this.#store?.close();
			this.#store = undefined;
		})();
		return this.#closing;
	}
	async #get(value: string, body?: string, signal?: AbortSignal): Promise<{ result: HttpResult; url: URL }> {
		if (this.#closed) throw new Error("资料存储已关闭");
		let next = value;
		for (let count = 0; count < 5; count++) {
			checkAbort(signal);
			const { url, addresses } = await assertPublicUrl(next, this.#resolver);
			checkAbort(signal);
			const result = await this.#send(url, addresses, body, signal);
			checkAbort(signal);
			if (result.body.length > SOURCE_LIMITS.fetchBytes) throw new Error("资料超过 5MB 上限");
			if ([301, 302, 303, 307, 308].includes(result.status)) {
				if (body !== undefined) throw new Error("搜索服务重定向被拒绝，避免凭据传给其他站点");
				if (!result.headers.location) throw new Error("重定向缺少目标地址");
				next = new URL(result.headers.location, url).href;
				continue;
			}
			if (result.status < 200 || result.status >= 300) throw new Error(`资料请求失败：HTTP ${result.status}`);
			return { result, url };
		}
		throw new Error("网页重定向次数过多");
	}
	async search(query: string, signal?: AbortSignal): Promise<Source[]> {
		const key = process.env[this.config.apiKeyEnv];
		if (!key) throw new Error(`Tavily 未配置，请设置 ${this.config.apiKeyEnv}；搜索不可用`);
		if (!query.trim() || query.length > 1000) throw new Error("搜索问题须为 1–1000 字");
		const { result } = await this.#get(
			"https://api.tavily.com/search",
			JSON.stringify({
				api_key: key,
				query,
				max_results: this.config.maxResults,
				search_depth: "basic",
				include_answer: false,
				include_raw_content: false,
			}),
			signal,
		);
		const data = JSON.parse(result.body.toString("utf8")) as {
			results?: { title: string; url: string; content: string }[];
		};
		if (!Array.isArray(data.results)) throw new Error("搜索服务返回格式不支持");
		const found: Source[] = [];
		for (const entry of data.results.slice(0, this.config.maxResults)) {
			checkAbort(signal);
			if (typeof entry.url !== "string" || typeof entry.title !== "string") continue;
			const snippet = String(entry.content ?? "");
			found.push(
				await this.#add(
					{
						title: entry.title,
						url: entry.url,
						read: false,
						text: snippet.slice(0, 4000),
						contentHash: digest(snippet),
						coverage: {
							...textCoverage(snippet, "search", result.body.length),
							extractedChars: Math.min(snippet.length, 4000),
							extractionTruncated: snippet.length > 4000,
						},
					},
					signal,
				),
			);
		}
		return found;
	}
	async fetch(value: string, signal?: AbortSignal): Promise<Source> {
		const { result, url } = await this.#get(value, undefined, signal);
		if (
			/application\/pdf/i.test(result.headers["content-type"] ?? "") ||
			url.pathname.toLowerCase().endsWith(".pdf")
		) {
			const extracted = await this.#pdf(result.body, "fetched", signal);
			return this.#add(
				{
					title: basename(url.pathname),
					url: value,
					finalUrl: url.href,
					read: true,
					contentHash: digest(result.body),
					...extracted,
				},
				signal,
			);
		}
		const raw = result.body.toString("utf8");
		if (/text\/html/i.test(result.headers["content-type"] ?? "") || /^\s*(?:<!doctype html|<html)/i.test(raw)) {
			const { document } = parseHTML(raw);
			const published =
				document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ?? undefined;
			document.querySelectorAll("script,style,noscript,nav").forEach((node: { remove(): void }) => node.remove());
			const parsed = new Readability(document).parse();
			const text = (parsed?.textContent ?? document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
			if (text.length < 20) throw new Error("页面正文无法提取；未记录为全文已读");
			return this.#add(
				{
					title: parsed?.title || document.title || url.hostname,
					url: value,
					finalUrl: url.href,
					read: true,
					contentHash: digest(result.body),
					text: text.slice(0, SOURCE_LIMITS.extractionChars),
					coverage: textCoverage(text, "fetched", result.body.length),
					...(published && !Number.isNaN(Date.parse(published)) ? { publishedAt: published } : {}),
				},
				signal,
			);
		}
		if (!/^(?:text\/|application\/(?:json|xml))/i.test(result.headers["content-type"] ?? "text/plain"))
			throw new Error("不支持此网页资料格式");
		return this.#add(
			{
				title: url.hostname + url.pathname,
				url: value,
				finalUrl: url.href,
				read: true,
				contentHash: digest(result.body),
				text: raw.slice(0, SOURCE_LIMITS.extractionChars),
				coverage: textCoverage(raw, "fetched", result.body.length),
			},
			signal,
		);
	}
	async #pdf(
		bytes: Buffer,
		acquisition: "local" | "fetched",
		signal?: AbortSignal,
	): Promise<SourceBody & { coverage: SourceCoverage }> {
		checkAbort(signal);
		const fontData =
			join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + sep;
		const loading = getDocument({
			data: new Uint8Array(bytes),
			isEvalSupported: false,
			useSystemFonts: false,
			standardFontDataUrl: fontData,
		});
		let timedOut = false;
		const abort = () => {
			void loading.destroy();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			abort();
		}, 15_000);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const document = await loading.promise;
			const pages: { page: number; text: string }[] = [];
			const truncatedPages: number[] = [];
			let text = "";
			for (let index = 1; index <= Math.min(document.numPages, SOURCE_LIMITS.pdfPages); index++) {
				if (signal?.aborted || timedOut) throw new Error("资料读取已取消或超时");
				const page = await document.getPage(index);
				const content = await page.getTextContent();
				if (signal?.aborted || timedOut) throw new Error("资料读取已取消或超时");
				const raw = content.items.map(item => ("str" in item ? item.str : "")).join(" ");
				const prefix = `${pages.length ? "\n" : ""}[第 ${index} 页] `;
				const budget = SOURCE_LIMITS.extractionChars - text.length - prefix.length;
				if (budget < 0) break;
				const kept = raw.slice(0, Math.min(SOURCE_LIMITS.pdfPageChars, budget));
				if (kept.length < raw.length) truncatedPages.push(index);
				pages.push({ page: index, text: kept });
				text += prefix + kept;
				page.cleanup();
				if (text.length >= SOURCE_LIMITS.extractionChars) break;
			}
			if (!pages.some(page => page.text.trim())) throw new Error("PDF 没有可提取文本；扫描件暂不支持 OCR");
			const truncated = pages.length < document.numPages || truncatedPages.length > 0;
			return {
				pages,
				text,
				coverage: {
					acquisition,
					fetchedBytes: bytes.length,
					fetchTruncated: false,
					extractedChars: text.length,
					totalChars: truncated ? null : text.length,
					extractionTruncated: truncated,
					totalPages: document.numPages,
					extractedPages: pages.length,
					truncatedPages,
					limits: { ...SOURCE_LIMITS },
				},
			};
		} catch (error) {
			if (signal?.aborted) throw new Error("资料读取已取消");
			if (timedOut) throw new Error("PDF 解析超过 15 秒上限");
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			await loading.destroy();
		}
	}
	async document(path: string, signal?: AbortSignal): Promise<Source> {
		if (this.#closed) throw new Error("资料存储已关闭");
		checkAbort(signal);
		if ((await stat(path)).size > SOURCE_LIMITS.fetchBytes) throw new Error("资料超过 5MB 上限");
		const bytes = await readFile(path, { signal });
		checkAbort(signal);
		if (bytes.length > SOURCE_LIMITS.fetchBytes) throw new Error("资料超过 5MB 上限");
		if (extname(path).toLowerCase() === ".pdf")
			return this.#add(
				{
					title: basename(path),
					path,
					read: true,
					contentHash: digest(bytes),
					...(await this.#pdf(bytes, "local", signal)),
				},
				signal,
			);
		if (![".md", ".txt", ".json", ".csv"].includes(extname(path).toLowerCase()))
			throw new Error("本地资料支持 Markdown、TXT、JSON、CSV 和文本 PDF");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return this.#add(
			{
				title: basename(path),
				path,
				read: true,
				contentHash: digest(bytes),
				text: text.slice(0, SOURCE_LIMITS.extractionChars),
				coverage: textCoverage(text, "local", bytes.length),
			},
			signal,
		);
	}
	report(claims: { text: string; sourceIds: string[]; inference?: boolean }[]): string {
		if (this.#closed) throw new Error("资料存储已关闭");
		const cited = new Map<string, SourceInfo>();
		const rows = claims.map(claim => {
			if (!claim.text.trim() || (!claim.sourceIds.length && !claim.inference))
				throw new Error("事实结论必须有已读取来源；推断需显式标记");
			const sources = claim.sourceIds.map(id => {
				const source = this.#store?.info(id);
				if (!source?.read) throw new Error(`来源 ${id} 未实际读取`);
				cited.set(source.id, source);
				return source;
			});
			return `${claim.inference ? "**推断：** " : ""}${claim.text} ${sources.map(source => `[${source.id}](${(source.finalUrl ?? source.url ?? source.path ?? "").replace(/\)/g, "%29")})`).join(" ")}\n`;
		});
		return `# 研究报告\n\n${rows.join("\n")}\n## 来源记录\n\n${[...cited.values()]
			.map(
				source =>
					`- ${source.id}：${source.title}；访问于 ${source.retrievedAt}${source.publishedAt ? `；发布于 ${source.publishedAt}` : "；发布日期未知"}`,
			)
			.join("\n")}\n`;
	}
}
