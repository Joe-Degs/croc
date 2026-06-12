/**
 * Agent Host — Direct-child Pi agent hosting for Runtime V2
 *
 * Spawns `pi --mode rpc` as a direct child process (no terminal multiplexer, no shell),
 * parses RPC JSONL events, normalizes them into RuntimeAgentEvents,
 * manages mailbox delivery, and produces exit summaries.
 *
 * This replaces the legacy terminal-session hosting path with
 * a programmatic parent-child model where the caller has full process
 * ownership.
 *
 * Key differences from the legacy path:
 *   1. No terminal-session backend — `spawn()` with `shell: false`
 *   2. No sidecar tailing — events flow directly to the caller via callbacks
 *   3. No PID-file orphan guessing — caller owns the process handle
 *   4. Registry integration — manifests updated on status transitions
 *   5. Pi CLI resolved to JS entrypoint, not .CMD shim
 *
 * @module taskplane/agent-host
 * @since TP-104
 */

import { spawn, type ChildProcess } from "child_process";
import {
	readFileSync,
	writeFileSync,
	appendFileSync,
	mkdirSync,
	existsSync,
	readdirSync,
	renameSync,
} from "fs";
import { join, dirname, basename, resolve, relative, isAbsolute } from "path";
import { StringDecoder } from "string_decoder";

import type {
	RuntimeAgentId,
	RuntimeAgentRole,
	RuntimeAgentEvent,
	RuntimeAgentEventType,
	RuntimeProjection,
	RuntimeAgentManifest,
	PacketPaths,
} from "./types.ts";

import {
	createManifest,
	writeManifest,
	updateManifestStatus,
	buildRegistrySnapshot,
	writeRegistrySnapshot,
} from "./process-registry.ts";
import { appendMailboxAuditEvent } from "./mailbox.ts";
import { resolvePiCliPath } from "./path-resolver.ts";

// ── Pi CLI Resolution ────────────────────────────────────────────────
// resolvePiCliPath() is imported from path-resolver.ts and re-exported below (TP-157)

export { resolvePiCliPath };

// ── Worker Tools Allowlist (TP-184) ─────────────────────────────────

/**
 * Engine-internal tools that the orchestrator's bridge extension
 * (`agent-bridge-extension.ts`) registers for every spawned worker. These
 * tools are coordination primitives owned by taskplane, NOT user-facing
 * capabilities, so they must be present in the worker's `--tools` allowlist
 * regardless of what `taskRunner.worker.tools` is configured to.
 *
 * If a worker is spawned without one of these tools in its allowlist, pi's
 * tool gate filters the registered tool out and the matching feature
 * silently no-ops:
 *   - `review_step`:                plan/code/test reviews never fire at
 *                                   any Review Level >= 1
 *   - `notify_supervisor`:          worker cannot reply to supervisor
 *                                   steering messages
 *   - `escalate_to_supervisor`:     worker cannot escalate blockers or
 *                                   ambiguity to the supervisor/operator
 *   - `request_segment_expansion`:  multi-repo segment expansion
 *                                   unreachable (the request file IPC is
 *                                   never written)
 *
 * Keep this list in sync with the registrations in
 * `agent-bridge-extension.ts` (lines ~137, 180, 230, 599).
 *
 * @see https://github.com/HenryLach/taskplane/issues/530
 * @since TP-184
 */
export const ENGINE_BRIDGE_TOOLS = [
	"review_step",
	"notify_supervisor",
	"escalate_to_supervisor",
	"request_segment_expansion",
] as const;

// TP-189 (Cluster B): `DEFAULT_WORKER_USER_TOOLS` now lives in the
// import-free `./tool-allowlist-constants.ts` module so that pure-data
// layers (`config-schema.ts`, `types.ts`) can import it without pulling
// agent-host's heavy `child_process`/`fs` imports into the schema/type
// graph. We re-export here so existing internal imports (e.g.,
// `execution.ts`, `worker-tools-allowlist.test.ts`) continue to work
// without churn.
//
// @since TP-184 (constant introduced) / TP-189 (moved to constants module)
export { DEFAULT_WORKER_USER_TOOLS } from "./tool-allowlist-constants.ts";
import { DEFAULT_WORKER_USER_TOOLS } from "./tool-allowlist-constants.ts";

/**
 * Build the final worker `--tools` allowlist string by combining the
 * user-tools portion (from config or {@link DEFAULT_WORKER_USER_TOOLS}) with
 * {@link ENGINE_BRIDGE_TOOLS} (always appended, deduplicated).
 *
 * Semantics:
 *   - `null` / `undefined` / empty / whitespace-only input → falls back to
 *     {@link DEFAULT_WORKER_USER_TOOLS}
 *   - Non-empty input → split on `,`, trim each entry, drop empties
 *   - All three bridge tools are appended; duplicates are dropped via Set
 *   - Returned string has no leading/trailing commas, no whitespace
 *
 * Call this exactly **once** in the spawn pipeline (currently
 * `lane-runner.ts:580`) — augmentation is intended to be a single,
 * idempotent layer; double-application is harmless (deduplicated) but
 * obscures the data flow.
 *
 * @see https://github.com/HenryLach/taskplane/issues/530
 * @since TP-184
 */
export function buildWorkerToolsAllowlist(userTools: string | undefined | null): string {
	const userPart = (userTools && userTools.trim()) || DEFAULT_WORKER_USER_TOOLS;
	const rawUserList = userPart
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// Guard against delimiter-only / whitespace-only inputs (e.g. ",", " , ")
	// that would otherwise parse to an empty list and yield bridge-tools-only
	// workers with no file/shell capabilities.
	const userList =
		rawUserList.length > 0
			? rawUserList
			: DEFAULT_WORKER_USER_TOOLS.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
	const merged = new Set<string>(userList);
	for (const t of ENGINE_BRIDGE_TOOLS) merged.add(t);
	return Array.from(merged).join(",");
}

// ── Conversation Payload Helpers (TP-111) ───────────────────────────────

/** Maximum characters for conversation event text payloads. */
const MAX_CONV_PAYLOAD_CHARS = 2000;

/** Maximum UTF-8 bytes for per-event tool output payloads. */
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
const MAX_RUNTIME_PROJECTION_STRING_BYTES = 32 * 1024;
const MAX_RUNTIME_PROJECTION_EVENT_BYTES = 256 * 1024;
const MAX_RUNTIME_PROJECTION_DEPTH = 16;
const MAX_RUNTIME_PROJECTION_ARRAY_ITEMS = 200;
const MAX_RUNTIME_PROJECTION_OBJECT_KEYS = 200;
const MAX_PI_RPC_JSONL_LINE_BYTES = 1024 * 1024;

export interface ProjectionOptions {
	maxStringBytes?: number;
	maxTotalEventBytes?: number;
	maxDepth?: number;
	maxArrayItems?: number;
	maxObjectKeys?: number;
	cwd?: string;
	pathPolicy?: "relativize" | "preserve" | "omit-absolute";
}

/** Truncate a string to maxLen chars, appending ellipsis if truncated. */
function truncatePayload(text: string, maxLen: number): string {
	const { value } = redactString(text);
	if (value.length <= maxLen) return value;
	return sliceGraphemeUtf16(value, maxLen) + "…";
}

function redactedPreview(text: string, maxLen: number): string {
	const { value } = redactString(text);
	return sliceGraphemeUtf16(value, maxLen);
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const segment of graphemeSegments(text)) {
		const segmentBytes = Buffer.byteLength(segment, "utf8");
		if (bytes + segmentBytes > maxBytes) break;
		bytes += segmentBytes;
		end += segment.length;
	}
	return text.slice(0, end);
}

function sliceGraphemeUtf16(text: string, maxUnits: number): string {
	let units = 0;
	let end = 0;
	for (const segment of graphemeSegments(text)) {
		if (units + segment.length > maxUnits) break;
		units += segment.length;
		end += segment.length;
	}
	return text.slice(0, end);
}

function graphemeSegments(text: string): string[] {
	const Segmenter = Intl.Segmenter;
	if (typeof Segmenter === "function") {
		return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
	}
	return Array.from(text);
}

function boundedTextPayload(text: string, maxBytes: number): Record<string, unknown> {
	const { value, redacted } = redactString(text);
	const originalBytes = Buffer.byteLength(value, "utf8");
	if (originalBytes <= maxBytes) return redacted ? { text: value, redacted: true } : { text: value };
	return {
		text: truncateUtf8Bytes(value, maxBytes),
		truncated: true,
		originalBytes,
		...(redacted ? { redacted: true } : {}),
	};
}

function redactString(text: string): { value: string; redacted: boolean } {
	let value = text;
	const replacements: Array<[RegExp, string | ((match: string) => string)]> = [
		[/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED:token]"],
		[/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED:authorization]"],
		[/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED:token]"],
		[/\bkey-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED:token]"],
		[/\btoken-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED:token]"],
		[/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:token]"],
		[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:access_key]"],
		[/AWS_SECRET_ACCESS_KEY\s*=\s*[^\s\n]+/gi, "AWS_SECRET_ACCESS_KEY=[REDACTED:secret]"],
		[/\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*[^\s\n]+/gi, (match) => `${match.split("=")[0]}=[REDACTED:secret]`],
		[/"(?:api_key|apikey|token|password|secret|authorization|private_key)"\s*:\s*"[^"]*"/gi, (match) => `${match.split(":")[0]}:"[REDACTED:secret]"`],
		[/Cookie:\s*[^\n\r]+/gi, "Cookie: [REDACTED:cookie]"],
		[/([?&](?:token|api_key|apikey|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED:token]"],
		[/-----BEGIN [^-]*(?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/g, "[REDACTED:private_key]"],
		[/Authorization:\s*[^\n\r]+/gi, "Authorization: [REDACTED:authorization]"],
	];
	for (const [pattern, replacement] of replacements) {
		value = typeof replacement === "string" ? value.replace(pattern, replacement) : value.replace(pattern, replacement);
	}
	return { value, redacted: value !== text };
}

function isSensitiveKey(key: string): string | null {
	const normalized = key.toLowerCase();
	if (normalized.includes("authorization")) return "authorization";
	if (normalized.includes("cookie")) return "cookie";
	if (normalized.includes("private_key")) return "private_key";
	for (const token of ["token", "api_key", "apikey", "password", "secret", "access_key", "session_key", "credential"]) {
		if (normalized.includes(token)) return token;
	}
	if (/(?:_key|_token|_secret)$/i.test(key)) return "secret";
	return null;
}

function isNumericTelemetryKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return normalized === "tokens" || /(?:^|_)?tokens?(?:before|after|saved|input|output|read|write)?$/i.test(key);
}

function truncateUtf8WithMetadata(text: string, maxBytes: number): { value: string; truncated: boolean; originalBytes?: number } {
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= maxBytes) return { value: text, truncated: false };
	return { value: truncateUtf8Bytes(text, maxBytes), truncated: true, originalBytes };
}

function pathForChild(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function normalizeProjectedPath(value: string, path: string, options: Required<ProjectionOptions>, omittedPaths: string[]): string {
	if (options.pathPolicy === "preserve" || !isAbsolute(value)) return value;
	if (options.pathPolicy === "relativize") {
		const rel = relative(options.cwd, value);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
		return value;
	}
	omittedPaths.push(path);
	return "[omitted:absolute-path]";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function projectRuntimeValue(value: unknown, options: ProjectionOptions = {}): RuntimeProjection {
	const opts: Required<ProjectionOptions> = {
		maxStringBytes: options.maxStringBytes ?? MAX_RUNTIME_PROJECTION_STRING_BYTES,
		maxTotalEventBytes: options.maxTotalEventBytes ?? MAX_RUNTIME_PROJECTION_EVENT_BYTES,
		maxDepth: options.maxDepth ?? MAX_RUNTIME_PROJECTION_DEPTH,
		maxArrayItems: options.maxArrayItems ?? MAX_RUNTIME_PROJECTION_ARRAY_ITEMS,
		maxObjectKeys: options.maxObjectKeys ?? MAX_RUNTIME_PROJECTION_OBJECT_KEYS,
		cwd: resolve(options.cwd ?? process.cwd()),
		pathPolicy: options.pathPolicy ?? "relativize",
	};
	const omittedPaths: string[] = [];
	const redactedPaths: string[] = [];
	let truncated = false;
	let redacted = false;
	let firstOriginalBytes: number | undefined;
	const seen = new WeakSet<object>();

	function walk(input: unknown, path: string, depth: number, keyHint?: string): unknown {
		const sensitive = keyHint ? isSensitiveKey(keyHint) : null;
		if (sensitive) {
			if (typeof input === "number" && keyHint && isNumericTelemetryKey(keyHint)) return input;
			redacted = true;
			redactedPaths.push(path);
			return `[REDACTED:${sensitive}]`;
		}
		if (typeof input === "string") {
			let next = input;
			if (keyHint === "path" || keyHint?.endsWith("Path")) next = normalizeProjectedPath(next, path, opts, omittedPaths);
			const redaction = redactString(next);
			if (redaction.redacted) {
				redacted = true;
				redactedPaths.push(path);
			}
			const limited = truncateUtf8WithMetadata(redaction.value, opts.maxStringBytes);
			if (limited.truncated) {
				truncated = true;
				omittedPaths.push(path);
				firstOriginalBytes ??= limited.originalBytes;
			}
			return limited.value;
		}
		if (typeof input === "number" || typeof input === "boolean" || input === null) return input;
		if (typeof input === "bigint") {
			truncated = true;
			omittedPaths.push(path);
			return "[BigInt]";
		}
		if (typeof input === "function") {
			truncated = true;
			omittedPaths.push(path);
			return "[Function]";
		}
		if (typeof input === "symbol" || typeof input === "undefined") {
			truncated = true;
			omittedPaths.push(path);
			return typeof input === "symbol" ? "[Symbol]" : "[Undefined]";
		}
		if (!isRecord(input)) return String(input);
		if (seen.has(input)) {
			truncated = true;
			omittedPaths.push(path);
			return "[Circular]";
		}
		if (depth >= opts.maxDepth) {
			truncated = true;
			omittedPaths.push(path);
			return "[Omitted:max-depth]";
		}
		if (Buffer.isBuffer(input)) {
			truncated = true;
			omittedPaths.push(path);
			return { type: "Buffer", bytes: input.byteLength };
		}
		if (ArrayBuffer.isView(input)) {
			truncated = true;
			omittedPaths.push(path);
			return { type: input.constructor.name, bytes: input.byteLength };
		}
		if (input instanceof Date) return Number.isNaN(input.getTime()) ? "[Invalid Date]" : input.toISOString();
		if (input instanceof RegExp) return input.toString();
		if (input instanceof Error) return { name: input.name, message: walk(input.message, `${path}.message`, depth + 1, "message") };
		seen.add(input);
		if (Array.isArray(input)) {
			const items = input.slice(0, opts.maxArrayItems).map((item, index) => walk(item, `${path}[${index}]`, depth + 1));
			if (input.length > opts.maxArrayItems) {
				truncated = true;
				omittedPaths.push(`${path}[${opts.maxArrayItems}]`);
			}
			return items;
		}
		if (input instanceof Map || input instanceof Set || !isPlainObject(input)) {
			truncated = true;
			omittedPaths.push(path);
			return `[${input.constructor.name}]`;
		}
		const output: Record<string, unknown> = {};
		const keys = Object.keys(input).sort();
		for (const key of keys.slice(0, opts.maxObjectKeys)) {
			const childPath = pathForChild(path, key);
			output[key] = walk(input[key], childPath, depth + 1, key);
		}
		if (keys.length > opts.maxObjectKeys) {
			truncated = true;
			omittedPaths.push(pathForChild(path, keys[opts.maxObjectKeys] ?? "*"));
		}
		return output;
	}

	let projectedValue = walk(value, "$", 0);
	let visibleBytes = Buffer.byteLength(JSON.stringify(projectedValue), "utf8");
	if (visibleBytes > opts.maxTotalEventBytes) {
		const capped = pruneProjectedValue(projectedValue, opts.maxTotalEventBytes, omittedPaths);
		projectedValue = capped.value;
		visibleBytes = capped.visibleBytes;
		truncated = true;
	}
	return {
		version: 1,
		value: projectedValue,
		truncated,
		redacted,
		...(firstOriginalBytes && !redacted ? { originalBytes: firstOriginalBytes } : {}),
		visibleBytes,
		omittedPaths,
		redactedPaths,
	};
}

function pruneProjectedValue(value: unknown, maxBytes: number, omittedPaths: string[]): { value: unknown; visibleBytes: number } {
	let next = value;
	for (const path of textHeavyPaths(value)) {
		next = replaceProjectedPath(next, path, "[Omitted:event-size-cap]");
		omittedPaths.push(path);
		const bytes = Buffer.byteLength(JSON.stringify(next), "utf8");
		if (bytes <= maxBytes) return { value: next, visibleBytes: bytes };
	}
	omittedPaths.push("$");
	const fallback = "[Omitted:event-size-cap]";
	return { value: fallback, visibleBytes: Buffer.byteLength(JSON.stringify(fallback), "utf8") };
}

function textHeavyPaths(value: unknown): string[] {
	const paths: Array<{ path: string; priority: number; bytes: number }> = [];
	function visit(input: unknown, path: string, keyHint?: string) {
		if (typeof input === "string") {
			const key = keyHint?.toLowerCase() ?? "";
			const priority = /^(content|text|output|delta|snapshot|patch|diff|summary|command|assistantmessage|newpromptpreview)$/.test(key) ? 0 : 1;
			paths.push({ path, priority, bytes: Buffer.byteLength(input, "utf8") });
			return;
		}
		if (!isRecord(input)) return;
		if (Array.isArray(input)) {
			for (const [index, item] of input.entries()) visit(item, `${path}[${index}]`);
			return;
		}
		for (const [key, child] of Object.entries(input)) visit(child, pathForChild(path, key), key);
	}
	visit(value, "$", undefined);
	return paths.sort((a, b) => a.priority - b.priority || b.bytes - a.bytes).map((entry) => entry.path);
}

function replaceProjectedPath(value: unknown, path: string, replacement: unknown): unknown {
	if (path === "$") return replacement;
	const clone = structuredClone(value);
	const parts = path.match(/(?:\.([A-Za-z_$][\w$]*))|(?:\[(\d+)\])|(?:\[("(?:\\.|[^"])*")\])/g) ?? [];
	let cursor: unknown = clone;
	for (let index = 0; index < parts.length - 1; index++) {
		cursor = pathPartValue(cursor, parts[index]!);
	}
	const last = parts.at(-1);
	if (!last || !isRecord(cursor)) return clone;
	const key = pathPartKey(last);
	if (key !== null) cursor[key] = replacement;
	return clone;
}

function pathPartValue(source: unknown, part: string): unknown {
	if (!isRecord(source)) return undefined;
	const key = pathPartKey(part);
	return key === null ? undefined : source[key];
}

function pathPartKey(part: string): string | null {
	if (part.startsWith(".")) return part.slice(1);
	if (/^\[\d+\]$/.test(part)) return part.slice(1, -1);
	if (part.startsWith("[") && part.endsWith("]")) return JSON.parse(part.slice(1, -1));
	return null;
}

function pickFields(source: unknown, fields: string[]): Record<string, unknown> | null {
	if (!isRecord(source)) return null;
	const picked: Record<string, unknown> = {};
	for (const field of fields) {
		if (field in source) picked[field] = source[field];
	}
	return Object.keys(picked).length > 0 ? picked : null;
}

export function projectToolArgs(toolName: string, args: unknown, options: ProjectionOptions = {}): RuntimeProjection | null {
	const normalized = toolName.toLowerCase();
	const fields = normalized === "write"
		? ["path", "content"]
		: normalized === "edit" || normalized === "multiedit" || normalized === "multi_edit"
			? ["path", "edits", "oldText", "newText", "replacement"]
			: normalized === "bash" || normalized === "shell" || normalized === "terminal"
				? ["command", "timeout"]
				: normalized === "read"
					? ["path", "offset", "limit"]
					: [];
	const picked = pickFields(args, fields);
	if (picked) return projectRuntimeValue(picked, options);
	return args == null ? null : projectRuntimeValue(args, options);
}

export function projectToolPartialResult(_toolName: string, partialResult: unknown, options: ProjectionOptions = {}): RuntimeProjection | null {
	return partialResult == null ? null : projectRuntimeValue(partialResult, options);
}

export function projectToolFinalResult(_toolName: string, result: unknown, options: ProjectionOptions = {}): RuntimeProjection | null {
	return result == null ? null : projectRuntimeValue(result, options);
}

export function projectToolResultDetails(_toolName: string, result: unknown, options: ProjectionOptions = {}): RuntimeProjection | null {
	if (!isRecord(result) || !isRecord(result.details)) return null;
	return projectRuntimeValue(result.details, options);
}

export function sanitizeRuntimePayload(_type: RuntimeAgentEventType, payload: unknown, options: ProjectionOptions = {}): unknown {
	return projectRuntimeValue(payload, options).value;
}

export function enforceRuntimeEventSize(event: RuntimeAgentEvent): RuntimeAgentEvent {
	let json = JSON.stringify(event);
	if (Buffer.byteLength(json, "utf8") <= MAX_RUNTIME_PROJECTION_EVENT_BYTES) return event;
	const payload = { ...event.payload };
	for (const key of ["partialResultProjection", "resultProjection", "argsProjection", "detailsProjection"]) {
		if (!payload[key]) continue;
		const pruned = pruneRuntimeProjectionForEventSize(payload[key]);
		if (pruned) {
			payload[key] = pruned;
			json = JSON.stringify({ ...event, payload });
			if (Buffer.byteLength(json, "utf8") <= MAX_RUNTIME_PROJECTION_EVENT_BYTES) return { ...event, payload };
		}
		payload[key] = {
			version: 1,
			value: "[Omitted:event-size-cap]",
			truncated: true,
			redacted: false,
			visibleBytes: 26,
			omittedPaths: ["$"],
			redactedPaths: [],
		};
		json = JSON.stringify({ ...event, payload });
		if (Buffer.byteLength(json, "utf8") <= MAX_RUNTIME_PROJECTION_EVENT_BYTES) return { ...event, payload };
	}
	const prunedPayload = pruneRuntimePayloadForEventSize(event, payload);
	if (prunedPayload) return { ...event, payload: prunedPayload };
	return {
		...event,
		payload: {
			summary: "event payload omitted because it exceeded Runtime V2 size cap",
			truncated: true,
		},
	};
}

const RUNTIME_TEXT_HEAVY_PAYLOAD_KEYS = [
	"content",
	"text",
	"output",
	"outputDelta",
	"delta",
	"snapshot",
	"patch",
	"diff",
	"summary",
	"command",
	"argsPreview",
	"assistantMessage",
	"newPromptPreview",
	"message",
	"error",
];

const RUNTIME_COMPACT_PAYLOAD_KEYS = [
	"streamId",
	"messageId",
	"tool",
	"toolCallId",
	"displayMode",
	"path",
	"isFinal",
	"isError",
	"truncated",
	"redacted",
	"originalBytes",
	"attempt",
	"exitCode",
	"signal",
	"durationMs",
	"timedOut",
	"broadcast",
	"interceptionCount",
	"supervisorConsulted",
	"action",
	"reason",
];

function pruneRuntimePayloadForEventSize(event: RuntimeAgentEvent, payload: Record<string, unknown>): Record<string, unknown> | null {
	const pruned = { ...payload };
	let changed = false;
	for (const key of RUNTIME_TEXT_HEAVY_PAYLOAD_KEYS) {
		if (!(key in pruned)) continue;
		delete pruned[key];
		changed = true;
		pruned.truncated = true;
	}
	if (changed) {
		const bytes = Buffer.byteLength(JSON.stringify({ ...event, payload: pruned }), "utf8");
		if (bytes <= MAX_RUNTIME_PROJECTION_EVENT_BYTES) return pruned;
	}

	const compact: Record<string, unknown> = {};
	for (const key of RUNTIME_COMPACT_PAYLOAD_KEYS) {
		const value = payload[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
			compact[key] = value;
		}
	}
	compact.truncated = true;
	if (Object.keys(compact).length > 1) {
		const bytes = Buffer.byteLength(JSON.stringify({ ...event, payload: compact }), "utf8");
		if (bytes <= MAX_RUNTIME_PROJECTION_EVENT_BYTES) return compact;
	}
	return null;
}

function pruneRuntimeProjectionForEventSize(value: unknown): RuntimeProjection | null {
	if (!isRecord(value) || value.version !== 1) return null;
	const omittedPaths = Array.isArray(value.omittedPaths) ? value.omittedPaths.filter((path) => typeof path === "string") : [];
	const pruned = pruneProjectedValue(value.value, Math.floor(MAX_RUNTIME_PROJECTION_EVENT_BYTES / 2), omittedPaths);
	return {
		version: 1,
		value: pruned.value,
		truncated: true,
		redacted: value.redacted === true,
		visibleBytes: pruned.visibleBytes,
		omittedPaths,
		redactedPaths: Array.isArray(value.redactedPaths) ? value.redactedPaths.filter((path) => typeof path === "string") : [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function firstStringField(source: Record<string, unknown>, fields: string[]): string | null {
	for (const field of fields) {
		const value = source[field];
		if (typeof value === "string" && value) return value;
	}
	return null;
}

function extractToolCallId(source: Record<string, unknown>): string | null {
	const direct = firstStringField(source, ["toolCallId", "tool_call_id"]);
	if (direct) return direct;
	const message = source.message;
	if (isRecord(message)) return firstStringField(message, ["toolCallId", "tool_call_id", "id"]);
	return null;
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block: unknown): block is { text: string } => isRecord(block) && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function extractResultText(source: Record<string, unknown>): string {
	const result = source.result;
	if (typeof result === "string") return result;
	if (isRecord(result)) {
		const contentText = extractContentText(result.content);
		if (contentText) return contentText;
		const text = firstStringField(result, ["text", "output", "summary"]);
		if (text) return text;
	}
	const output = firstStringField(source, ["output", "text", "summary"]);
	return output ?? "";
}

function classifyToolDisplayMode(toolName: string): "terminal" | "file" | "edit" | "summary" {
	const normalized = toolName.toLowerCase();
	if (["bash", "shell", "terminal"].includes(normalized)) return "terminal";
	if (["edit", "write", "multiedit", "multi_edit", "apply_patch"].includes(normalized))
		return "edit";
	if (["read", "grep", "glob", "ls", "list", "find"].includes(normalized)) return "file";
	return "summary";
}

function previewToolArgs(args: unknown): { argsPreview: string; path: string } {
	if (typeof args === "string") {
		return { argsPreview: redactedPreview(args, 300), path: "" };
	}
	if (!isRecord(args)) return { argsPreview: "", path: "" };

	const path = typeof args.path === "string" ? redactedPreview(args.path, 200) : "";
	for (const value of Object.values(args)) {
		if (typeof value === "string") return { argsPreview: redactedPreview(value, 300), path };
	}
	return { argsPreview: "", path };
}

/**
 * Extract text content from a Pi RPC message_end event's message object.
 * Pi may return content as a string or as an array of content blocks.
 */
function extractAssistantText(message: Record<string, unknown>): string {
	// Direct string content
	if (typeof message.content === "string") return message.content;
	// Array of content blocks (Anthropic format)
	// Guard: skip null/non-object entries to prevent TypeError on malformed streams
	if (Array.isArray(message.content)) return extractContentText(message.content);
	// Fallback: try text field
	if (typeof message.text === "string") return message.text;
	return "";
}

// ── Types ────────────────────────────────────────────────────────────

/**
 * Options for spawning an agent via the direct host.
 *
 * @since TP-104
 */
export interface AgentHostOptions {
	/** Stable agent identity */
	agentId: RuntimeAgentId;
	/** Agent role */
	role: RuntimeAgentRole;
	/** Batch ID this agent belongs to */
	batchId: string;
	/** Lane number (null for merge agents) */
	laneNumber: number | null;
	/** Task ID being executed (null before first assignment) */
	taskId: string | null;
	/** Repo ID the agent is operating in */
	repoId: string;
	/** Working directory for the Pi process */
	cwd: string;
	/** User prompt content */
	prompt: string;
	/** Optional system prompt content */
	systemPrompt?: string;
	/** Model identifier (e.g., "anthropic/claude-sonnet-4-20250514") */
	model?: string;
	/** Comma-separated tool list */
	tools?: string;
	/** Thinking mode override */
	thinking?: string;
	/** Extension paths to load */
	extensions?: string[];
	/** Skill paths to load */
	skills?: string[];
	/** Mailbox directory for steering (null = no mailbox) */
	mailboxDir?: string | null;
	/** Steering-pending JSONL path (TP-090, worker-only) */
	steeringPendingPath?: string | null;
	/** Path to persist normalized events JSONL */
	eventsPath?: string | null;
	/** Path to write exit summary JSON */
	exitSummaryPath?: string | null;
	/** Timeout in milliseconds (0 = no timeout) */
	timeoutMs?: number;
	/** Delay in ms before closing stdin after agent_end (default: 100) */
	closeDelayMs?: number;
	/** State root for process registry (null = no registry integration) */
	stateRoot?: string | null;
	/** Packet paths for registry manifest (null for merge agents) */
	packet?: PacketPaths | null;
	/** Extra environment variables for the child process */
	env?: Record<string, string>;
	/**
	 * Callback invoked when agent_end fires, before stdin is closed.
	 * Receives the last assistant message text.
	 * Return a string to send as a new prompt (re-prompt the agent),
	 * or null to close the session normally.
	 *
	 * @since TP-172
	 */
	onPrematureExit?: (assistantMessage: string) => Promise<string | null>;
	/**
	 * Maximum number of exit interceptions before forcing session close.
	 * Prevents infinite loops where the callback always returns a new prompt.
	 * Default: 2
	 *
	 * @since TP-172
	 */
	maxExitInterceptions?: number;
}

export interface CompactionTelemetryEvent {
	phase: "started" | "ended";
	reason?: string;
	legacy?: boolean;
	status?: "completed" | "aborted" | "failed" | "skipped";
	success?: boolean;
	aborted?: boolean;
	willRetry?: boolean;
	errorMessage?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	tokensSaved?: number;
}

/**
 * Accumulated telemetry from a completed agent session.
 *
 * @since TP-104
 */
export interface AgentHostResult {
	/** Process exit code (null if killed by signal) */
	exitCode: number | null;
	/** Signal that killed the process (null if exited normally) */
	signal: string | null;
	/** Wall-clock duration in milliseconds */
	durationMs: number;
	/** Whether the process was killed by the caller */
	killed: boolean;
	/** Total input tokens */
	inputTokens: number;
	/** Total output tokens */
	outputTokens: number;
	/** Cache read tokens */
	cacheReadTokens: number;
	/** Cache write tokens */
	cacheWriteTokens: number;
	/** Cumulative cost in USD */
	costUsd: number;
	/** Number of tool calls */
	toolCalls: number;
	/** Last tool call description */
	lastTool: string;
	/** Number of auto-retries */
	retries: number;
	/** Number of auto-compactions */
	compactions: number;
	/** Number of compaction starts */
	compactionsStarted: number;
	/** Number of completed compactions */
	compactionsCompleted: number;
	/** Ordered compaction lifecycle records */
	compactionEvents: CompactionTelemetryEvent[];
	/** Authoritative context usage from Pi */
	contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
	/** Final error message (null if clean exit) */
	error: string | null;
	/** Whether agent_end was received */
	agentEnded: boolean;
	/** Captured stderr tail (last 2KB) */
	stderrTail: string;
}

/**
 * Callback for normalized agent events.
 *
 * @since TP-104
 */
export type AgentEventCallback = (event: RuntimeAgentEvent) => void;

/**
 * Callback for telemetry updates (called on each message_end).
 *
 * @since TP-104
 */
export type AgentTelemetryCallback = (result: Partial<AgentHostResult>) => void;

// ── JSONL Helpers ────────────────────────────────────────────────────

const MAILBOX_MESSAGE_TYPES = new Set(["steer", "query", "abort", "info", "reply", "escalate"]);

function isValidMailboxMessage(obj: any): boolean {
	if (!obj || typeof obj !== "object") return false;
	return (
		typeof obj.id === "string" &&
		typeof obj.batchId === "string" &&
		typeof obj.from === "string" &&
		typeof obj.to === "string" &&
		typeof obj.timestamp === "number" &&
		Number.isFinite(obj.timestamp) &&
		typeof obj.type === "string" &&
		MAILBOX_MESSAGE_TYPES.has(obj.type) &&
		typeof obj.content === "string"
	);
}

export function readHighestRuntimeEventSeq(eventsPath: string): number {
	try {
		if (!existsSync(eventsPath)) return 0;
		let maxSeq = 0;
		for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as { seq?: unknown };
				const seq = event.seq;
				if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > maxSeq) maxSeq = seq;
			} catch {
				continue;
			}
		}
		return maxSeq;
	} catch {
		return 0;
	}
}

// ── Core Host Function ───────────────────────────────────────────────

/**
 * Spawn and manage a Pi agent as a direct child process.
 *
 * Returns a promise that resolves with the full session result when
 * the agent exits, plus a kill function for early termination.
 *
 * @param opts - Agent host options
 * @param onEvent - Optional callback for normalized events
 * @param onTelemetry - Optional callback for telemetry updates
 * @returns Object with promise (resolves on exit) and kill function
 *
 * @since TP-104
 */
export function spawnAgent(
	opts: AgentHostOptions,
	onEvent?: AgentEventCallback,
	onTelemetry?: AgentTelemetryCallback,
): { promise: Promise<AgentHostResult>; kill: () => void } {
	const cliPath = resolvePiCliPath();
	const closeDelayMs = opts.closeDelayMs ?? 100;
	const timeoutMs = opts.timeoutMs ?? 0;
	const maxExitInterceptions = opts.maxExitInterceptions ?? 3;
	let nextEventSeq = opts.eventsPath ? readHighestRuntimeEventSeq(opts.eventsPath) + 1 : 1;

	// Build Pi CLI arguments
	const piArgs: string[] = [cliPath, "--mode", "rpc", "--no-session"];
	if (opts.model) piArgs.push("--model", opts.model);
	if (opts.tools) piArgs.push("--tools", opts.tools);
	if (opts.systemPrompt) piArgs.push("--system-prompt", opts.systemPrompt);
	// Always pass --no-extensions to prevent auto-discovery from cwd.
	// Explicit -e entries are still honored by pi even with --no-extensions.
	// This matches the fix from TP-095 that eliminated duplicate extension loading.
	piArgs.push("--no-extensions");
	if (opts.extensions && opts.extensions.length > 0) {
		for (const ext of opts.extensions) {
			piArgs.push("-e", ext);
		}
	}
	piArgs.push("--no-skills");
	if (opts.skills && opts.skills.length > 0) {
		for (const skill of opts.skills) {
			piArgs.push("--skill", skill);
		}
	}
	if (opts.thinking) piArgs.push("--thinking", opts.thinking);

	// Spawn directly — no shell, no terminal multiplexer
	const proc = spawn(process.execPath, piArgs, {
		shell: false,
		cwd: opts.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...(opts.env ?? {}) },
	});

	// State accumulator
	const startedAt = Date.now();
	let killed = false;
	let timedOut = false;
	let agentEnded = false;
	let stdinClosed = false;
	let assistantMessageEnds = 0;
	const STATS_REFRESH_EVERY_ASSISTANT_MESSAGES = 5;
	let inputTokens = 0,
		outputTokens = 0,
		cacheReadTokens = 0,
		cacheWriteTokens = 0;
	let costUsd = 0,
		toolCalls = 0,
		retries = 0,
		compactions = 0;
	let compactionsStarted = 0,
		compactionsCompleted = 0;
	let compactionActive = false;
	const compactionEvents: CompactionTelemetryEvent[] = [];
	let lastTool = "",
		error: string | null = null;
	let contextUsage: AgentHostResult["contextUsage"] = null;
	let stderrBuffer = "";
	const STDERR_MAX = 2048;
	/** Last assistant message text captured from message_end events (TP-172) */
	let lastAssistantMessage = "";
	/** Number of times exit interception has occurred (TP-172) */
	let exitInterceptionCount = 0;
	/** Whether the current turn had any tool calls (TP-172: text-only gate) */
	let currentTurnHadToolCalls = false;
	const liveToolOutputById = new Map<string, string>();
	const emittedToolResults = new Set<string>();
	const projectionOptions: ProjectionOptions = { cwd: opts.cwd };
	const fallbackAssistantStreamId = `local-assistant-${process.pid}-${startedAt}`;
	const fallbackThinkingStreamId = `local-thinking-${process.pid}-${startedAt}`;

	// Timeout
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	let stdinCloseHandle: ReturnType<typeof setTimeout> | null = null;
	if (timeoutMs > 0) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			killed = true;
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}, timeoutMs);
	}

	const REGISTRY_REFRESH_INTERVAL_MS = 1_000;
	let lastRegistryRefreshAt = 0;
	const refreshRegistrySnapshot = (force: boolean = false) => {
		if (!opts.stateRoot) return;
		const now = Date.now();
		if (!force && now - lastRegistryRefreshAt < REGISTRY_REFRESH_INTERVAL_MS) return;
		try {
			const snapshot = buildRegistrySnapshot(opts.stateRoot, opts.batchId);
			writeRegistrySnapshot(opts.stateRoot, snapshot);
			lastRegistryRefreshAt = now;
		} catch {
			/* best effort */
		}
	};

	// Registry integration: write manifest before process is considered visible
	if (opts.stateRoot) {
		const manifest = createManifest({
			batchId: opts.batchId,
			agentId: opts.agentId,
			role: opts.role,
			laneNumber: opts.laneNumber,
			taskId: opts.taskId,
			repoId: opts.repoId,
			pid: proc.pid ?? 0,
			parentPid: process.pid,
			cwd: opts.cwd,
			packet: opts.packet ?? null,
		});
		manifest.status = "running";
		writeManifest(opts.stateRoot, manifest);
		refreshRegistrySnapshot(true);
	}

	function cancelScheduledStdinClose() {
		if (!stdinCloseHandle) return;
		clearTimeout(stdinCloseHandle);
		stdinCloseHandle = null;
	}

	// Helper: close stdin safely with delay
	function closeStdin() {
		if (stdinClosed || stdinCloseHandle || compactionActive) return;
		const endStdin = () => {
			stdinCloseHandle = null;
			if (stdinClosed || compactionActive) return;
			stdinClosed = true;
			try {
				proc.stdin?.end();
			} catch {
				/* ignore */
			}
		};
		if (closeDelayMs > 0) {
			stdinCloseHandle = setTimeout(endStdin, closeDelayMs);
		} else {
			endStdin();
		}
	}

	function collectCompactionTokenCounts(result: unknown): Pick<CompactionTelemetryEvent, "tokensBefore" | "tokensAfter" | "tokensSaved"> {
		if (!isRecord(result)) return {};
		const counts: Pick<CompactionTelemetryEvent, "tokensBefore" | "tokensAfter" | "tokensSaved"> = {};
		if (typeof result.tokensBefore === "number") counts.tokensBefore = result.tokensBefore;
		if (typeof result.tokensAfter === "number") counts.tokensAfter = result.tokensAfter;
		if (typeof result.tokensSaved === "number") counts.tokensSaved = result.tokensSaved;
		return counts;
	}

	function handleCompactionStart(event: Record<string, unknown>) {
		cancelScheduledStdinClose();
		compactionActive = true;
		compactions++;
		compactionsStarted++;
		const reason = typeof event.reason === "string" ? event.reason : undefined;
		const record: CompactionTelemetryEvent = { phase: "started", ...(reason ? { reason } : {}) };
		compactionEvents.push(record);
		emitEvent("compaction_started", { ...(reason ? { reason } : {}) });
	}

	function handleLegacyCompactionStart(event: Record<string, unknown>) {
		compactions++;
		const reason = typeof event.reason === "string" ? event.reason : undefined;
		const payload = { ...(reason ? { reason } : {}), legacy: true };
		compactionEvents.push({ phase: "started", ...payload });
		emitEvent("compaction_started", payload);
	}

	function handleCompactionEnd(event: Record<string, unknown>) {
		compactionActive = false;
		const aborted = event.aborted === true;
		const willRetry = event.willRetry === true;
		const hasResult = isRecord(event.result);
		const completed = hasResult && !aborted && event.success !== false;
		const success = completed;
		if (completed) compactionsCompleted++;
		if (willRetry) agentEnded = false;

		const reason = typeof event.reason === "string" ? event.reason : undefined;
		const errorMessage = firstStringField(event, ["errorMessage", "error"]);
		const status: CompactionTelemetryEvent["status"] = aborted ? "aborted" : success ? "completed" : errorMessage || event.success === false ? "failed" : "skipped";
		const tokenCounts = success ? collectCompactionTokenCounts(event.result) : {};
		const payload = {
			...(reason ? { reason } : {}),
			status,
			success,
			aborted,
			willRetry,
			...(errorMessage ? { errorMessage } : {}),
			...tokenCounts,
		};
		compactionEvents.push({ phase: "ended", ...payload });
		emitEvent("compaction_finished", payload);
		if (agentEnded && !willRetry) closeStdin();
	}

	// Helper: emit normalized event
	function emitEvent(type: RuntimeAgentEventType, payload: Record<string, unknown> = {}) {
		const sanitizedPayload = sanitizeRuntimePayload(type, payload, projectionOptions) as Record<string, unknown>;
		const event = enforceRuntimeEventSize({
			seq: nextEventSeq++,
			batchId: opts.batchId,
			agentId: opts.agentId,
			role: opts.role,
			laneNumber: opts.laneNumber,
			taskId: opts.taskId,
			repoId: opts.repoId,
			ts: Date.now(),
			type,
			payload: sanitizedPayload,
		});
		if (onEvent) onEvent(event);
		// Persist to events JSONL if path is provided
		if (opts.eventsPath) {
			try {
				mkdirSync(dirname(opts.eventsPath), { recursive: true });
				appendFileSync(opts.eventsPath, JSON.stringify(event) + "\n", "utf-8");
			} catch {
				/* best effort */
			}
		}
	}

	// Helper: check mailbox and inject (own inbox + _broadcast)
	function checkMailbox() {
		if (!opts.mailboxDir || !proc.stdin || proc.stdin.destroyed) return;

		const expectedSessionName = basename(opts.mailboxDir);
		const expectedBatchId = basename(dirname(opts.mailboxDir));

		// Collect messages from own inbox AND broadcast inbox
		const inboxDirs: Array<{ dir: string; isBroadcast: boolean }> = [
			{ dir: join(opts.mailboxDir, "inbox"), isBroadcast: false },
		];
		// TP-106: Also check _broadcast/inbox for broadcast messages
		const broadcastInbox = join(dirname(opts.mailboxDir), "_broadcast", "inbox");
		if (existsSync(broadcastInbox)) {
			inboxDirs.push({ dir: broadcastInbox, isBroadcast: true });
		}

		for (const { dir: inboxDir, isBroadcast } of inboxDirs) {
			if (!existsSync(inboxDir)) continue;

			let entries: string[];
			try {
				entries = readdirSync(inboxDir);
			} catch {
				continue;
			}

			const msgFiles = entries
				.filter((f) => f.endsWith(".msg.json") && !f.endsWith(".msg.json.tmp"))
				.sort();
			if (msgFiles.length === 0) continue;

			const ackDir = join(opts.mailboxDir, "ack");

			for (const filename of msgFiles) {
				try {
					const raw = readFileSync(join(inboxDir, filename), "utf-8");
					const msg = JSON.parse(raw);
					if (!isValidMailboxMessage(msg)) continue;
					if (msg.batchId !== expectedBatchId) continue;
					// Validate 'to' field: own inbox requires exact match, broadcast accepts "_broadcast"
					if (!isBroadcast && msg.to !== expectedSessionName) continue;
					if (isBroadcast && msg.to !== "_broadcast") continue;

					mkdirSync(ackDir, { recursive: true });
					const ackPath = join(ackDir, filename);
					// Broadcast fan-out: if this agent already acked this broadcast message,
					// skip to avoid duplicate delivery while preserving message for peers.
					if (isBroadcast && existsSync(ackPath)) continue;

					proc.stdin.write(JSON.stringify({ type: "steer", message: msg.content }) + "\n");

					if (isBroadcast) {
						// Do NOT remove the shared broadcast inbox file. Persist a per-agent
						// ack marker so all agents can consume the same broadcast exactly once.
						try {
							writeFileSync(ackPath, raw, "utf-8");
						} catch {
							/* best effort */
						}
					} else {
						try {
							renameSync(join(inboxDir, filename), ackPath);
						} catch {
							/* race ok */
						}
					}

					emitEvent("message_delivered", {
						messageId: msg.id,
						content: msg.content,
						broadcast: isBroadcast,
					});
					if (opts.stateRoot) {
						appendMailboxAuditEvent(opts.stateRoot, expectedBatchId, {
							type: "message_delivered",
							from: msg.from,
							to: isBroadcast ? expectedSessionName : msg.to,
							messageId: msg.id,
							messageType: msg.type,
							contentPreview: msg.content.slice(0, 200),
							broadcast: isBroadcast,
						});
					}

					// TP-090: steering-pending flag
					if (opts.steeringPendingPath) {
						try {
							appendFileSync(
								opts.steeringPendingPath,
								JSON.stringify({ ts: msg.timestamp, content: msg.content, id: msg.id }) + "\n",
								"utf-8",
							);
						} catch {
							/* best effort */
						}
					}
				} catch {
					/* skip malformed */
				}
			}
		}
	}

	const promise = new Promise<AgentHostResult>((resolvePromise) => {
		let stdoutBuf = "";
		const decoder = new StringDecoder("utf8");
		let finished = false;
		let droppingOversizedStdoutLine = false;

		function finish(exitCode: number | null, signal: string | null) {
			if (finished) return;
			finished = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);

			const result: AgentHostResult = {
				exitCode,
				signal,
				durationMs: Date.now() - startedAt,
				killed,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				costUsd,
				toolCalls,
				lastTool,
				retries,
				compactions,
				compactionsStarted,
				compactionsCompleted,
				compactionEvents: [...compactionEvents],
				contextUsage,
				error,
				agentEnded,
				stderrTail: stderrBuffer.trim().slice(-STDERR_MAX),
			};

			// Write exit summary if path provided
			if (opts.exitSummaryPath) {
				try {
					mkdirSync(dirname(opts.exitSummaryPath), { recursive: true });
					const summary = {
						exitCode: result.exitCode,
						exitSignal: result.signal,
						tokens:
							inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0
								? {
										input: inputTokens,
										output: outputTokens,
										cacheRead: cacheReadTokens,
										cacheWrite: cacheWriteTokens,
									}
								: null,
						cost: costUsd > 0 ? costUsd : null,
						toolCalls,
						retries,
						compactions,
						compactionsStarted,
						compactionsCompleted,
						compactionEvents,
						durationSec: Math.round(result.durationMs / 1000),
						lastToolCall: lastTool || null,
						error: error || null,
						contextUsage: contextUsage || null,
					};
					writeFileSync(opts.exitSummaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
				} catch {
					/* best effort */
				}
			}

			const exitEventType: RuntimeAgentEventType = timedOut
				? "agent_timeout"
				: killed
					? "agent_killed"
					: exitCode === 0 && agentEnded
						? "agent_exited"
						: "agent_crashed";
			emitEvent(exitEventType, { exitCode, signal, durationMs: result.durationMs, timedOut });

			// Registry integration: update manifest to terminal status
			if (opts.stateRoot) {
				const terminalStatus = timedOut
					? ("timed_out" as const)
					: killed
						? ("killed" as const)
						: exitCode === 0 && agentEnded
							? ("exited" as const)
							: ("crashed" as const);
				updateManifestStatus(opts.stateRoot, opts.batchId, opts.agentId, terminalStatus);
				refreshRegistrySnapshot(true);
			}

			resolvePromise(result);
		}

		proc.stdout.on("data", (chunk: Buffer | string) => {
			stdoutBuf += typeof chunk === "string" ? chunk : decoder.write(chunk);
			if (droppingOversizedStdoutLine) {
				const nextLine = stdoutBuf.indexOf("\n");
				if (nextLine < 0) {
					stdoutBuf = "";
					return;
				}
				stdoutBuf = stdoutBuf.slice(nextLine + 1);
				droppingOversizedStdoutLine = false;
			}
			if (Buffer.byteLength(stdoutBuf, "utf8") > MAX_PI_RPC_JSONL_LINE_BYTES && !stdoutBuf.includes("\n")) {
				stdoutBuf = "";
				droppingOversizedStdoutLine = true;
				emitEvent("runtime_warning", { message: "oversized Pi RPC JSONL line omitted" });
				return;
			}
			let idx: number;
			while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
				let line = stdoutBuf.slice(0, idx);
				stdoutBuf = stdoutBuf.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				if (Buffer.byteLength(line, "utf8") > MAX_PI_RPC_JSONL_LINE_BYTES) {
					emitEvent("runtime_warning", { message: "oversized Pi RPC JSONL line omitted" });
					continue;
				}

				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (!event || !event.type) continue;

				// Accumulate telemetry
				switch (event.type) {
					case "message_end": {
						const usage = event.message?.usage;
						if (usage) {
							inputTokens += usage.input || 0;
							outputTokens += usage.output || 0;
							cacheReadTokens += usage.cacheRead || 0;
							cacheWriteTokens += usage.cacheWrite || 0;
							if (usage.cost) {
								costUsd +=
									typeof usage.cost === "object"
										? usage.cost.total || 0
										: typeof usage.cost === "number"
											? usage.cost
											: 0;
							}
						}
						// TP-111: Emit assistant_message with bounded content
						if (event.message?.role === "assistant") {
							const content = extractAssistantText(event.message);
							if (content) {
								emitEvent("assistant_message", { text: truncatePayload(content, MAX_CONV_PAYLOAD_CHARS) });
								// TP-172: Track last assistant message for exit interception
								lastAssistantMessage = content;
							}
						}
						if (isRecord(event.message) && event.message.role === "toolResult") {
							const toolCallId = extractToolCallId(event);
							if (!toolCallId || !emittedToolResults.has(toolCallId)) {
								const output = extractContentText(event.message.content);
								if (output) {
								const payload = {
									tool: firstStringField(event.message, ["toolName", "tool"]),
									summary: redactedPreview(output, 200),
										displayMode: classifyToolDisplayMode(
											firstStringField(event.message, ["toolName", "tool"]) ?? "tool",
										),
										...boundedTextPayload(output, MAX_TOOL_OUTPUT_BYTES),
										...(toolCallId ? { toolCallId } : {}),
									};
									emitEvent("tool_result", payload);
									if (toolCallId) emittedToolResults.add(toolCallId);
								}
							}
						}
						// Request session stats immediately on first assistant message,
						// then periodically at a bounded cadence to refresh context usage.
						if (event.message?.role === "assistant") {
							assistantMessageEnds += 1;
							if (
								assistantMessageEnds === 1 ||
								assistantMessageEnds % STATS_REFRESH_EVERY_ASSISTANT_MESSAGES === 0
							) {
								try {
									proc.stdin?.write(JSON.stringify({ type: "get_session_stats" }) + "\n");
								} catch {
									/* ignore */
								}
							}
						}
						// Check mailbox
						checkMailbox();
						// Keep registry snapshot freshness while agent is active.
						refreshRegistrySnapshot(false);
						// Emit telemetry update
						if (onTelemetry) {
							onTelemetry({
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								costUsd,
								toolCalls,
								lastTool,
								contextUsage,
							});
						}
						break;
					}
					case "tool_execution_start": {
						toolCalls++;
						currentTurnHadToolCalls = true;
						const toolName = event.toolName || event.tool || "tool";
						const { argsPreview: argPreview, path: toolPath } = previewToolArgs(event.args);
						lastTool = argPreview ? `${toolName}: ${argPreview}` : toolName;
						// TP-111: Bounded payload only — no raw args in durable event log
						const toolCallId = extractToolCallId(event);
					const argsProjection = projectToolArgs(toolName, event.args, projectionOptions);
						emitEvent("tool_call", {
							tool: toolName,
							path: toolPath,
							argsPreview: argPreview,
							displayMode: classifyToolDisplayMode(toolName),
							...(toolCallId ? { toolCallId } : {}),
							...(argsProjection ? { argsProjection } : {}),
						});
						break;
					}
					case "tool_execution_update": {
						const toolName = event.toolName || event.tool || "tool";
						const toolCallId = extractToolCallId(event);
						const output = isRecord(event.partialResult)
							? extractContentText(event.partialResult.content)
							: "";
					const partialResultProjection = projectToolPartialResult(toolName, event.partialResult, projectionOptions);
					const detailsProjection = projectToolResultDetails(toolName, event.partialResult, projectionOptions);
						if (!output) {
							if (partialResultProjection || detailsProjection) {
								emitEvent("tool_output_update", {
									tool: toolName,
									displayMode: classifyToolDisplayMode(toolName),
									...(toolCallId ? { toolCallId } : {}),
									...(partialResultProjection ? { partialResultProjection } : {}),
									...(detailsProjection ? { detailsProjection } : {}),
								});
							}
							break;
						}

						const liveKey = toolCallId ?? toolName;
						const previous = liveToolOutputById.get(liveKey) ?? "";
						const delta = output.startsWith(previous) ? output.slice(previous.length) : output;
						liveToolOutputById.set(liveKey, output);
						if (!delta) break;

						emitEvent("tool_output_update", {
							tool: toolName,
							displayMode: classifyToolDisplayMode(toolName),
							...(delta ? boundedTextPayload(delta, MAX_TOOL_OUTPUT_BYTES) : {}),
							...(toolCallId ? { toolCallId } : {}),
							...(partialResultProjection ? { partialResultProjection } : {}),
							...(detailsProjection ? { detailsProjection } : {}),
						});
						break;
					}
					case "tool_execution_end": {
						const toolName = event.toolName || event.tool || "tool";
						const toolCallId = extractToolCallId(event);
						const output = extractResultText(event);
					const resultProjection = projectToolFinalResult(toolName, event.result, projectionOptions);
					const detailsProjection = projectToolResultDetails(toolName, event.result, projectionOptions);
						const payload = {
							tool: toolName,
							summary: redactedPreview(output, 200),
							displayMode: classifyToolDisplayMode(toolName),
							isError: event.isError === true,
							...boundedTextPayload(output, MAX_TOOL_OUTPUT_BYTES),
							...(toolCallId ? { toolCallId } : {}),
							...(resultProjection ? { resultProjection } : {}),
							...(detailsProjection ? { detailsProjection } : {}),
						};
						emitEvent("tool_result", payload);
						if (toolCallId) emittedToolResults.add(toolCallId);
						break;
					}
					case "message_update": {
						const message = isRecord(event.message) ? event.message : event;
						const messageId = firstStringField(message, ["id", "messageId", "message_id"]);
					const streamId = firstStringField(event, ["streamId", "stream_id", "id"]);
						const delta = firstStringField(event, ["delta", "textDelta", "text_delta"])
							?? firstStringField(message, ["delta", "textDelta", "text_delta"]);
						const snapshot = firstStringField(event, ["snapshot", "text", "content"])
							?? firstStringField(message, ["snapshot", "text", "content"]);
						const thinking = firstStringField(event, ["thinkingDelta", "thinking_delta", "reasoningDelta", "reasoning_delta", "thinking", "reasoning"])
							?? firstStringField(message, ["thinkingDelta", "thinking_delta", "reasoningDelta", "reasoning_delta", "thinking", "reasoning"]);
						const toolCallId = extractToolCallId(event);
						const toolName = firstStringField(event, ["toolName", "tool"])
							?? firstStringField(message, ["toolName", "tool"]);
						const argsValue = event.args ?? event.toolArgs ?? message.args ?? message.toolArgs;
						const isFinal = event.isFinal === true || message.isFinal === true;
						if (toolCallId && argsValue !== undefined) {
						const argsProjection = projectToolArgs(toolName ?? "tool", argsValue, projectionOptions);
							emitEvent("tool_args_update", {
								toolCallId,
								...(toolName ? { tool: toolName } : {}),
								...(argsProjection ? { argsProjection } : {}),
								isFinal,
							});
						}
					if (thinking) {
						emitEvent("assistant_thinking_update", {
							...(messageId ? { messageId } : {}),
							streamId: streamId ?? fallbackThinkingStreamId,
							...boundedTextPayload(thinking, MAX_RUNTIME_PROJECTION_STRING_BYTES),
							isFinal,
						});
					}
					if (delta || snapshot) {
						emitEvent("assistant_message_update", {
							...(messageId ? { messageId } : {}),
							streamId: streamId ?? fallbackAssistantStreamId,
							...(delta ? { delta: boundedTextPayload(delta, MAX_RUNTIME_PROJECTION_STRING_BYTES).text } : {}),
							...(snapshot ? { snapshot: boundedTextPayload(snapshot, MAX_RUNTIME_PROJECTION_STRING_BYTES).text } : {}),
								isFinal,
							});
						}
						break;
					}
					case "auto_retry_start":
					case "retry_start": {
						retries++;
						emitEvent("retry_started", {
							attempt: event.attempt,
							error: event.errorMessage || event.error,
						});
						break;
					}
					case "auto_compaction_start": {
						handleLegacyCompactionStart(event);
						break;
					}
					case "compaction_start": {
						handleCompactionStart(event);
						break;
					}
					case "auto_compaction_end":
					case "auto_compaction_finish":
					case "compaction_finish":
					case "compaction_end": {
						handleCompactionEnd(event);
						break;
					}
					case "response": {
						if (event.success === false && event.error) {
							error = event.error;
						}
						if (event.success === true && event.data?.contextUsage) {
							contextUsage = event.data.contextUsage;
							emitEvent("context_usage", { ...event.data.contextUsage });
							// Emit telemetry immediately so context % is live in dashboard
							if (onTelemetry) {
								onTelemetry({
									inputTokens,
									outputTokens,
									cacheReadTokens,
									cacheWriteTokens,
									costUsd,
									toolCalls,
									lastTool,
									contextUsage,
								});
							}
						}
						break;
					}
					case "agent_end": {
						agentEnded = true;
						// TP-172: Exit interception — intercept any exit when callback
						// is provided and under limit. The callback (lane-runner) decides
						// whether the worker made progress. We don't gate on tool calls
						// because workers commonly use tools (reads/greps) then exit
						// with a text declaration ("Now let me fix this:") without
						// actually making the edit.
						const shouldIntercept = opts.onPrematureExit && exitInterceptionCount < maxExitInterceptions;
						if (shouldIntercept) {
							exitInterceptionCount++;
							const INTERCEPTION_TIMEOUT_MS = 120_000; // 2 minute safety timeout
							// Wrap in Promise.resolve().then() to catch synchronous throws
							const interceptPromise = Promise.resolve().then(() =>
								opts.onPrematureExit!(lastAssistantMessage),
							);
							const timeoutPromise = new Promise<null>((res) =>
								setTimeout(() => res(null), INTERCEPTION_TIMEOUT_MS),
							);
							Promise.race([interceptPromise, timeoutPromise]).then(
								(newPrompt: string | null) => {
									if (newPrompt && !stdinClosed && proc.stdin && !proc.stdin.destroyed) {
										// Re-prompt the agent with supervisor guidance
										agentEnded = false; // Reset for the new turn
										currentTurnHadToolCalls = false; // Reset for new turn
										proc.stdin.write(JSON.stringify({ type: "prompt", message: newPrompt }) + "\n");
										emitEvent("exit_intercepted", {
											interceptionCount: exitInterceptionCount,
											assistantMessage: truncatePayload(lastAssistantMessage, 500),
											supervisorConsulted: true,
											action: "reprompt",
											newPromptPreview: truncatePayload(newPrompt, MAX_CONV_PAYLOAD_CHARS),
										});
									} else {
										// Callback returned null or stdin already closed — close session
										const reason = stdinClosed
											? "stdin_closed"
											: newPrompt === null
												? "callback_returned_null"
												: "unknown";
										emitEvent("exit_intercepted", {
											interceptionCount: exitInterceptionCount,
											assistantMessage: truncatePayload(lastAssistantMessage, 500),
											supervisorConsulted: true,
											action: "close",
											reason,
										});
										closeStdin();
									}
								},
								(err: unknown) => {
									// Callback rejected — emit single diagnostic event and close
									const msg = err instanceof Error ? err.message : String(err);
									emitEvent("exit_intercepted", {
										interceptionCount: exitInterceptionCount,
										assistantMessage: truncatePayload(lastAssistantMessage, 500),
										supervisorConsulted: false,
										action: "close",
										reason: "callback_error",
										error: msg,
									});
									closeStdin();
								},
							);
						} else {
							// No callback, had tool calls, or interception limit reached — close normally
							if (opts.onPrematureExit && exitInterceptionCount >= maxExitInterceptions) {
								emitEvent("exit_intercepted", {
									interceptionCount: exitInterceptionCount,
									assistantMessage: truncatePayload(lastAssistantMessage, 500),
									supervisorConsulted: false,
									action: "close",
									reason: "max_interceptions_reached",
								});
							}
							closeStdin();
						}
						break;
					}
				}
			}
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			stderrBuffer += chunk;
			if (stderrBuffer.length > STDERR_MAX * 2) {
				stderrBuffer = stderrBuffer.slice(-STDERR_MAX);
			}
		});

		proc.on("error", (err: Error) => {
			error = `spawn error: ${err.message}`;
			finish(null, null);
		});

		proc.on("close", (code: number | null, signal: string | null) => {
			finish(code, signal);
		});

		// Send steering mode and prompt
		if (opts.mailboxDir) {
			proc.stdin.write(JSON.stringify({ type: "set_steering_mode", mode: "all" }) + "\n");
		}
		proc.stdin.write(JSON.stringify({ type: "prompt", message: opts.prompt }) + "\n");

		emitEvent("agent_started", { model: opts.model, cwd: opts.cwd });
		// TP-111: Emit prompt_sent with bounded preview
		emitEvent("prompt_sent", { text: truncatePayload(opts.prompt, MAX_CONV_PAYLOAD_CHARS) });
	});

	const kill = () => {
		killed = true;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	};

	return { promise, kill };
}
