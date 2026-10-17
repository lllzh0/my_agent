/** Character offsets use JavaScript UTF-16 positions, starting at 1. */
export interface SourceRange {
	offset: number;
	end: number;
	totalChars: number;
	nextOffset?: number;
	page?: number;
	nextPage?: number;
	truncated: boolean;
}

export interface SourceCoverage {
	acquisition: "search" | "fetched" | "local" | "legacy";
	fetchedBytes: number | null;
	fetchTruncated: boolean | null;
	extractedChars: number;
	/** Null when unparsed PDF pages or a legacy record prevent an exact count. */
	totalChars: number | null;
	extractionTruncated: boolean | null;
	totalPages?: number;
	extractedPages?: number;
	truncatedPages?: number[];
	limits: { fetchBytes: number; extractionChars: number; pdfPages: number; pdfPageChars: number };
}

export interface SourceInfo {
	id: string;
	title: string;
	url?: string;
	finalUrl?: string;
	path?: string;
	retrievedAt: string;
	publishedAt?: string;
	/** Digest of acquired bytes/snippet, including content beyond the extraction limit. */
	contentHash?: string;
	/** Evidence was acquired; this does not mean all text was returned to the model. */
	read: boolean;
	coverage: SourceCoverage;
}

export interface SourceBody {
	text: string;
	pages?: { page: number; text: string }[];
}

export interface StoredSource extends SourceInfo, SourceBody {}
export interface Source extends StoredSource {
	range: SourceRange;
	/** Initial PDF previews carry their own range; readSource retrieves full selected pages. */
	pages?: { page: number; text: string; range?: SourceRange }[];
}

export interface SourceReadOptions {
	offset?: number;
	limit?: number;
	page?: number;
	signal?: AbortSignal;
}

export interface SourceReadResult extends SourceInfo {
	text: string;
	range: SourceRange;
}

export interface SourceSearchOptions extends SourceReadOptions {
	ignoreCase?: boolean;
}

export interface SourceSearchResult extends SourceInfo {
	query: string;
	/** offset/end use the selected view; pageOffset locates a PDF match within its page. */
	matches: { offset: number; end: number; page?: number; pageOffset?: number; excerpt: string }[];
	nextOffset?: number;
	page?: number;
	/** True when the search covered the selected stored text from offset to its end. */
	complete: boolean;
}

export interface ResearchStats {
	sourceCount: number;
	contentCount: number;
	contentBytes: number;
	databaseBytes: number;
	recentCount: number;
}

export const SOURCE_LIMITS = {
	fetchBytes: 5_000_000,
	extractionChars: 2_000_000,
	pdfPages: 200,
	pdfPageChars: 100_000,
};
export const SOURCE_READ_LIMIT = 12_000;
export const SOURCE_RECENT_LIMIT = 50;
export const SOURCE_EXCERPT_LIMIT = 800;
