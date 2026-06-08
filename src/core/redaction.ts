function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (normalized.endsWith("env")) return false;
	return /apikey|secret|token|password|authorization|cookie|credential/.test(normalized);
}

function shouldRedactQueryParam(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		normalized === "key" ||
		normalized.endsWith("key") ||
		/api|secret|token|password|credential|auth|signature|sig/.test(normalized)
	);
}

function redactQueryParams(text: string): string {
	return text.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix: string, key: string) => {
		return shouldRedactQueryParam(key) ? `${prefix}${key}=[redacted]` : match;
	});
}

export function redactSensitiveText(text: string): string {
	return redactQueryParams(text)
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi, "$1[redacted]@")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

export function redactSecrets(value: unknown, key = ""): unknown {
	if (shouldRedactKey(key)) return typeof value === "string" && value.length > 0 ? "[redacted]" : value;
	if (typeof value === "string") return redactSensitiveText(value);
	if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
	if (!isRecord(value)) return value;
	const redacted: Record<string, unknown> = {};
	for (const [entryKey, entryValue] of Object.entries(value)) redacted[entryKey] = redactSecrets(entryValue, entryKey);
	return redacted;
}
