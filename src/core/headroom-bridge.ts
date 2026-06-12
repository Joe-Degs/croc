import type { CrocConfig } from "./config.ts";
import { redactSensitiveText } from "./redaction.ts";

export interface HeadroomRetrieveParams {
	hash?: unknown;
	query?: unknown;
}

export interface HeadroomRetriever {
	retrieve(hash: string, options?: { query?: string }): Promise<unknown>;
}

export interface RunHeadroomRetrieveOptions {
	retriever: HeadroomRetriever;
	baseUrl: string;
	maxResultBytes: number;
	signal: AbortSignal;
	trustedOrigins?: readonly string[];
}

const HASH_PATTERN = /^[a-fA-F0-9]{24}$/;
const LOCAL_BRIDGE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TRUNCATION_NOTE = "\n\n[truncated to fit Headroom CCR maxResultBytes]";

export function shouldRegisterHeadroomBridge(config: CrocConfig): boolean {
	return config.batteries.headroom.enabled === true && config.batteries.headroom.ccr.mode === "bridge";
}

export function getHeadroomBridgeBaseUrl(config: CrocConfig): string {
	return normalizeHeadroomBridgeBaseUrl(
		config.batteries.headroom.proxy.url,
		config.batteries.headroom.ccr.trustedOrigins,
	);
}

export function normalizeHeadroomBridgeBaseUrl(rawBaseUrl: string, trustedOrigins: readonly string[] = []): string {
	const normalized = normalizeOrigin(rawBaseUrl, "Headroom proxy.url");
	if (isLocalOrigin(normalized.hostname)) return normalized.baseUrl;

	const trusted = new Set(trustedOrigins.map((origin) => normalizeTrustedOrigin(origin)).filter(isString));
	if (!trusted.has(normalized.baseUrl)) {
		throw new Error(
			`Headroom CCR bridge origin ${redactSensitiveText(normalized.baseUrl)} is not trusted. Add the exact origin to ccr.trustedOrigins.`,
		);
	}
	return normalized.baseUrl;
}

export function validateHeadroomRetrieveParams(params: HeadroomRetrieveParams): { hash: string; query?: string } {
	if (!isRecord(params)) throw new Error("headroom_retrieve parameters must be an object.");

	const extraKeys = Object.keys(params).filter((key) => key !== "hash" && key !== "query");
	if (extraKeys.length > 0) throw new Error("headroom_retrieve only accepts hash and query parameters.");

	if (typeof params.hash !== "string") throw new Error("headroom_retrieve hash must be a string.");
	if (!HASH_PATTERN.test(params.hash)) {
		throw new Error("headroom_retrieve hash must be exactly 24 hexadecimal characters.");
	}

	if (params.query === undefined) return { hash: params.hash };
	if (typeof params.query !== "string") throw new Error("headroom_retrieve query must be a string when provided.");
	if (params.query.length > 1000) throw new Error("headroom_retrieve query must be 1000 characters or fewer.");
	return { hash: params.hash, query: params.query };
}

export function formatHeadroomRetrieveResult(result: unknown, maxBytes: number): string {
	return finalizeModelVisibleText(formatRawRetrieveResult(result), maxBytes);
}

export async function runHeadroomRetrieve(
	params: HeadroomRetrieveParams,
	options: RunHeadroomRetrieveOptions,
): Promise<string> {
	normalizeHeadroomBridgeBaseUrl(options.baseUrl, options.trustedOrigins ?? []);
	const { hash, query } = validateHeadroomRetrieveParams(params);
	if (options.signal.aborted)
		return finalizeModelVisibleText("Headroom CCR retrieval was aborted.", options.maxResultBytes);

	const retrieval = options.retriever.retrieve(hash, query ? { query } : undefined);
	retrieval.catch(() => {});

	try {
		const result = await raceWithAbort(retrieval, options.signal);
		return formatHeadroomRetrieveResult(result, options.maxResultBytes);
	} catch (error) {
		if (isAbortError(error)) {
			return finalizeModelVisibleText("Headroom CCR retrieval was aborted.", options.maxResultBytes);
		}
		return finalizeModelVisibleText(
			`Headroom CCR retrieval failed: ${safeErrorMessage(error)}`,
			options.maxResultBytes,
		);
	}
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw createAbortError();

	let abortHandler: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		abortHandler = () => reject(createAbortError());
		signal.addEventListener("abort", abortHandler, { once: true });
	});

	try {
		return await Promise.race([promise, abortPromise]);
	} finally {
		if (abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}

function createAbortError(): Error {
	const error = new Error("Headroom CCR retrieval was aborted.");
	error.name = "AbortError";
	return error;
}

function formatRawRetrieveResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (isMissingOrExpiredResult(result)) return "Headroom CCR entry is missing or expired.";
	if (isRecord(result) && typeof result.originalContent === "string") return formatDirectRetrieveResult(result);
	if (isRecord(result) && typeof result.query === "string" && Array.isArray(result.results)) {
		return formatQueryRetrieveResult(result);
	}
	return stableJsonStringify(result);
}

function formatDirectRetrieveResult(result: Record<string, unknown>): string {
	const lines = ["Headroom CCR original content"];
	appendStringMetadata(lines, "Hash", result.hash);
	appendNumberMetadata(lines, "Original tokens", result.originalTokens);
	appendNumberMetadata(lines, "Compressed tokens", result.compressedTokens);
	appendNumberMetadata(lines, "Original item count", result.originalItemCount);
	appendNumberMetadata(lines, "Compressed item count", result.compressedItemCount);
	lines.push("", String(result.originalContent));
	return lines.join("\n");
}

function formatQueryRetrieveResult(result: Record<string, unknown>): string {
	const lines = ["Headroom CCR query results"];
	appendStringMetadata(lines, "Hash", result.hash);
	appendStringMetadata(lines, "Query", result.query);
	appendNumberMetadata(lines, "Count", result.count);

	const results = Array.isArray(result.results) ? result.results : [];
	if (results.length === 0) {
		lines.push("", "No matching CCR content found.");
		return lines.join("\n");
	}

	for (const [index, entry] of results.entries()) {
		lines.push("", `Result ${index + 1}:`, formatQueryResultEntry(entry));
	}
	return lines.join("\n");
}

function formatQueryResultEntry(entry: unknown): string {
	if (!isRecord(entry)) return stableJsonStringify(entry);

	const lines: string[] = [];
	appendStringMetadata(lines, "Hash", entry.hash);
	appendNumberMetadata(lines, "Original tokens", entry.originalTokens);
	appendNumberMetadata(lines, "Compressed tokens", entry.compressedTokens);

	const content = firstString(entry.originalContent, entry.content, entry.text);
	if (content !== undefined) lines.push(content);
	else lines.push(stableJsonStringify(entry));
	return lines.join("\n");
}

function appendStringMetadata(lines: string[], label: string, value: unknown): void {
	if (typeof value === "string" && value.length > 0) lines.push(`${label}: ${value}`);
}

function appendNumberMetadata(lines: string[], label: string, value: unknown): void {
	if (typeof value === "number" && Number.isFinite(value)) lines.push(`${label}: ${value}`);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string") return value;
	}
	return undefined;
}

function isMissingOrExpiredResult(result: unknown): boolean {
	if (result === null || result === undefined) return true;
	if (!isRecord(result)) return false;
	if (result.found === false || result.exists === false || result.missing === true || result.expired === true)
		return true;

	const status = firstString(result.status, result.error, result.code, result.message)?.toLowerCase() ?? "";
	return /not[_ -]?found|missing|expired/.test(status);
}

function finalizeModelVisibleText(text: string, maxBytes: number): string {
	const byteLimit = normalizeMaxBytes(maxBytes);
	const redacted = removeStackTraces(redactSensitiveText(text));
	return truncateUtf8(redacted, byteLimit);
}

function normalizeMaxBytes(maxBytes: number): number {
	if (!Number.isFinite(maxBytes) || maxBytes < 1) {
		throw new Error("Headroom ccr.maxResultBytes must be a positive finite number.");
	}
	return Math.floor(maxBytes);
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;

	const noteBytes = Buffer.byteLength(TRUNCATION_NOTE, "utf-8");
	if (noteBytes >= maxBytes) return truncateUtf8Raw(TRUNCATION_NOTE, maxBytes);
	return `${truncateUtf8Raw(text, maxBytes - noteBytes)}${TRUNCATION_NOTE}`;
}

function truncateUtf8Raw(text: string, maxBytes: number): string {
	let usedBytes = 0;
	let output = "";
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf-8");
		if (usedBytes + charBytes > maxBytes) break;
		output += char;
		usedBytes += charBytes;
	}
	return output;
}

function removeStackTraces(text: string): string {
	return text
		.replace(/"([^"\n]*stack[^"\n]*)"\s*:\s*"(?:\\.|[^"\\])*"/gi, (_match, key: string) => `"${key}":"[redacted]"`)
		.replace(/\\n\s+at (?:\\(?!n).|[^"\\])*(?=(?:\\n|"))/g, "")
		.replace(/(?:^|\n)\s+at .+(?=\n|$)/g, "")
		.trim();
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
	const safe = removeStackTraces(redactSensitiveText(message)).trim();
	return safe.length > 0 ? safe : "unknown error";
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	return error instanceof DOMException && error.name === "AbortError";
}

interface NormalizedOrigin {
	baseUrl: string;
	hostname: string;
}

function normalizeOrigin(rawOrigin: string, label: string): NormalizedOrigin {
	if (typeof rawOrigin !== "string" || rawOrigin.trim().length === 0) throw new Error(`${label} is required.`);

	const trimmed = rawOrigin.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (error) {
		throw new Error(`${label} must be a valid URL: ${safeErrorMessage(error)}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use http or https.`);
	if (url.username.length > 0 || url.password.length > 0) throw new Error(`${label} must not include credentials.`);
	if (url.search.length > 0 || url.hash.length > 0)
		throw new Error(`${label} must not include query strings or hashes.`);
	if (url.pathname !== "/") throw new Error(`${label} must not include a path in v1.`);

	const port = extractExplicitPort(trimmed) ?? url.port;
	return {
		baseUrl: `${url.protocol}//${formatHost(url.hostname, port)}`,
		hostname: normalizeHostname(url.hostname),
	};
}

function normalizeTrustedOrigin(origin: string): string | undefined {
	if (typeof origin !== "string" || origin.includes("*")) return undefined;
	try {
		return normalizeOrigin(origin, "Headroom ccr.trustedOrigins entry").baseUrl;
	} catch {
		return undefined;
	}
}

function isLocalOrigin(hostname: string): boolean {
	return LOCAL_BRIDGE_HOSTS.has(normalizeHostname(hostname));
}

function extractExplicitPort(rawUrl: string): string | undefined {
	const schemeEnd = rawUrl.indexOf("://");
	if (schemeEnd === -1) return undefined;

	const authorityStart = schemeEnd + 3;
	const authorityEnd = rawUrl.slice(authorityStart).search(/[/?#]/);
	const authority = rawUrl.slice(authorityStart, authorityEnd === -1 ? undefined : authorityStart + authorityEnd);
	const host = authority.slice(authority.lastIndexOf("@") + 1);
	if (host.startsWith("[")) {
		const closingBracket = host.indexOf("]");
		if (closingBracket === -1 || host[closingBracket + 1] !== ":") return undefined;
		return host.slice(closingBracket + 2) || undefined;
	}

	const separator = host.lastIndexOf(":");
	if (separator === -1) return undefined;
	return host.slice(separator + 1) || undefined;
}

function formatHost(hostname: string, port: string): string {
	const normalizedHostname = normalizeHostname(hostname);
	const host = normalizedHostname.includes(":") ? `[${normalizedHostname}]` : normalizedHostname;
	return port.length > 0 ? `${host}:${port}` : host;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
}

function stableJsonStringify(value: unknown): string {
	const sorted = sortJsonValue(value, new WeakSet<object>());
	const json = JSON.stringify(sorted, null, "\t");
	return json === undefined ? String(value) : json;
}

function sortJsonValue(value: unknown, seen: WeakSet<object>): unknown {
	if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry, seen));
	if (!isRecord(value)) {
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "symbol") return value.toString();
		if (typeof value === "function") return "[Function]";
		return value;
	}

	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key], seen);
	seen.delete(value);
	return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: string | undefined): value is string {
	return typeof value === "string";
}
