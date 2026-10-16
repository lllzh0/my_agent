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
import { atomicJson, readJson } from "../storage.ts";

export interface Source {
	id: string;
	title: string;
	url?: string;
	finalUrl?: string;
	path?: string;
	retrievedAt: string;
	publishedAt?: string;
	read: boolean;
	text: string;
	pages?: { page: number; text: string }[];
}
export interface HttpResult {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}
export type Resolver = (hostname: string) => Promise<string[]>;
export type Transport = (url: URL, addresses: string[], body?: string, signal?: AbortSignal) => Promise<HttpResult>;
const dnsResolve: Resolver = async hostname => (await lookup(hostname, { all: true })).map(x => x.address);

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
				if (size > 5_000_000) req.destroy(new Error("资料超过 5MB 上限"));
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
		const value = await readJson(join(this.home, "sources.json"));
		if (Array.isArray(value)) this.sources.push(...(value as Source[]));
	}
	async #add(source: Omit<Source, "id" | "retrievedAt">): Promise<Source> {
		if (this.sources.length >= 200) throw new Error("本会话来源已达 200 项，请新开会话");
		const result = { ...source, id: `S${this.sources.length + 1}`, retrievedAt: new Date().toISOString() };
		this.sources.push(result);
		await atomicJson(join(this.home, "sources.json"), this.sources);
		return result;
	}
	async #get(value: string, body?: string, signal?: AbortSignal): Promise<{ result: HttpResult; url: URL }> {
		let next = value;
		for (let count = 0; count < 5; count++) {
			const { url, addresses } = await assertPublicUrl(next, this.#resolver);
			const result = await this.#send(url, addresses, body, signal);
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
			if (typeof entry.url !== "string" || typeof entry.title !== "string") continue;
			found.push(
				await this.#add({
					title: entry.title,
					url: entry.url,
					read: false,
					text: String(entry.content ?? "").slice(0, 4000),
				}),
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
			const extracted = await this.#pdf(result.body, signal);
			return this.#add({ title: basename(url.pathname), url: value, finalUrl: url.href, read: true, ...extracted });
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
			return this.#add({
				title: parsed?.title || document.title || url.hostname,
				url: value,
				finalUrl: url.href,
				read: true,
				text: text.slice(0, 40_000),
				...(published && !Number.isNaN(Date.parse(published)) ? { publishedAt: published } : {}),
			});
		}
		if (!/^(?:text\/|application\/(?:json|xml))/i.test(result.headers["content-type"] ?? "text/plain"))
			throw new Error("不支持此网页资料格式");
		return this.#add({
			title: url.hostname + url.pathname,
			url: value,
			finalUrl: url.href,
			read: true,
			text: raw.slice(0, 40_000),
		});
	}
	async #pdf(bytes: Buffer, signal?: AbortSignal): Promise<{ text: string; pages: { page: number; text: string }[] }> {
		if (signal?.aborted) throw new Error("资料读取已取消");
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
			for (let index = 1; index <= Math.min(document.numPages, 40); index++) {
				if (signal?.aborted || timedOut) throw new Error("资料读取已取消或超时");
				const page = await document.getPage(index);
				const content = await page.getTextContent();
				pages.push({
					page: index,
					text: content.items
						.map(item => ("str" in item ? item.str : ""))
						.join(" ")
						.slice(0, 10_000),
				});
				if (pages.reduce((size, entry) => size + entry.text.length, 0) >= 40_000) break;
			}
			if (!pages.some(page => page.text.trim())) throw new Error("PDF 没有可提取文本；扫描件暂不支持 OCR");
			return {
				pages,
				text: pages
					.map(page => `[第 ${page.page} 页] ${page.text}`)
					.join("\n")
					.slice(0, 40_000),
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
		if (signal?.aborted) throw new Error("资料读取已取消");
		if ((await stat(path)).size > 5_000_000) throw new Error("资料超过 5MB 上限");
		const bytes = await readFile(path);
		if (extname(path).toLowerCase() === ".pdf")
			return this.#add({ title: basename(path), path, read: true, ...(await this.#pdf(bytes, signal)) });
		if (![".md", ".txt", ".json", ".csv"].includes(extname(path).toLowerCase()))
			throw new Error("本地资料支持 Markdown、TXT、JSON、CSV 和文本 PDF");
		return this.#add({
			title: basename(path),
			path,
			read: true,
			text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, 40_000),
		});
	}
	report(claims: { text: string; sourceIds: string[]; inference?: boolean }[]): string {
		const rows = claims.map(claim => {
			if (!claim.text.trim() || (!claim.sourceIds.length && !claim.inference))
				throw new Error("事实结论必须有已读取来源；推断需显式标记");
			const sources = claim.sourceIds.map(id => {
				const source = this.sources.find(source => source.id === id);
				if (!source?.read) throw new Error(`来源 ${id} 未实际读取`);
				return source;
			});
			return `${claim.inference ? "**推断：** " : ""}${claim.text} ${sources.map(source => `[${source.id}](${(source.finalUrl ?? source.url ?? source.path ?? "").replace(/\)/g, "%29")})`).join(" ")}\n`;
		});
		return `# 研究报告\n\n${rows.join("\n")}\n## 来源记录\n\n${this.sources
			.filter(x => x.read)
			.map(
				source =>
					`- ${source.id}：${source.title}；访问于 ${source.retrievedAt}${source.publishedAt ? `；发布于 ${source.publishedAt}` : "；发布日期未知"}`,
			)
			.join("\n")}\n`;
	}
}
