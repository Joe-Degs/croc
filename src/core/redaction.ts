function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (normalized.endsWith("env")) return false;
	if (/^(original|compressed)tokens$/.test(normalized)) {
		return false;
	}
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

function redactPemBlocks(text: string): string {
	return text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted pem block]");
}

function redactQueryParams(text: string): string {
	return text.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix: string, key: string) => {
		return shouldRedactQueryParam(key) ? `${prefix}${key}=[redacted]` : match;
	});
}

function redactCookieHeaders(text: string): string {
	return text.replace(
		/(^|\n)(\s*(?:set-cookie|cookie)\s*:\s*)[^\n]*/gi,
		(_match, lineStart: string, prefix: string) => {
			return `${lineStart}${prefix}[redacted]`;
		},
	);
}

function redactMultilineSecretBlocks(text: string): string {
	return text.replace(
		/^(\s*([A-Za-z0-9_. -]*(?:api[-_ ]?key|secret|token|password|authorization|cookie|credential)[A-Za-z0-9_. -]*)\s*:\s*[|>][^\n]*\n)((?:[ \t]+.*(?:\n|$))+)/gim,
		(match, prefix: string, key: string) => (shouldRedactKey(key) ? `${prefix}[redacted]\n` : match),
	);
}

function redactJsonSecretValues(text: string): string {
	return text.replace(
		/("([^"\n]*(?:api[_-]?key|secret|token|password|authorization|cookie|credential)[^"\n]*)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
		(match, prefix: string, key: string) => (shouldRedactKey(key) ? `${prefix}"[redacted]"` : match),
	);
}

function redactLineSecretValues(text: string): string {
	return text.replace(
		/^(\s*([A-Za-z0-9_. -]*(?:api[-_ ]?key|secret|token|password|authorization|cookie|credential)[A-Za-z0-9_. -]*)\s*[:=]\s*).+$/gim,
		(match, prefix: string, key: string) => (shouldRedactKey(key) ? `${prefix}[redacted]` : match),
	);
}

export function redactSensitiveText(text: string): string {
	return redactLineSecretValues(
		redactJsonSecretValues(
			redactMultilineSecretBlocks(redactCookieHeaders(redactQueryParams(redactPemBlocks(text)))),
		),
	)
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi, "$1[redacted]@")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
		.replace(/\bBasic\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Basic [redacted]");
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
