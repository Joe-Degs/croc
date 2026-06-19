import type { TokenCounts } from "./types.ts";

export function formatDurationMs(ms: number | undefined | null): string {
	if (!Number.isFinite(ms) || (ms ?? 0) < 0) return "unknown";
	const seconds = Math.round((ms ?? 0) / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remaining = seconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${remaining}s`;
	return `${remaining}s`;
}

export function tokenTotal(tokens: Partial<TokenCounts> | undefined | null): number {
	if (!tokens) return 0;
	return (
		(tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)
	);
}

export function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

export function formatTokenTotal(tokens: Partial<TokenCounts> | undefined | null): string {
	return formatNumber(tokenTotal(tokens));
}

export function previewText(value: string, maxChars = 160): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact;
}
