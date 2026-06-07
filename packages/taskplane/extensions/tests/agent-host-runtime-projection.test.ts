import { describe, it, mock, beforeEach, afterEach } from "node:test";
import { expect } from "./expect.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PassThrough } from "stream";
import { EventEmitter } from "events";

type RuntimeAgentEvent = import("../taskplane/types.ts").RuntimeAgentEvent;

interface FakeChildProc extends EventEmitter {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: {
		destroyed: boolean;
		writes: string[];
		write: (chunk: string | Buffer) => boolean;
		end: () => void;
	};
	pid: number;
	kill: (signal?: NodeJS.Signals | number) => boolean;
}

let lastSpawnedProc: FakeChildProc | null = null;
const realChildProcess = await import("node:child_process");
const mockSpawnSync = mock.fn(() => ({ stdout: "", stderr: "", status: 0 }) as any);
const mockSpawn = mock.fn(() => {
	const proc = new EventEmitter() as FakeChildProc;
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.stdin = {
		destroyed: false,
		writes: [],
		write(chunk: string | Buffer) {
			this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
			return true;
		},
		end() {
			this.destroyed = true;
		},
	};
	proc.pid = 43210;
	proc.kill = () => true;
	lastSpawnedProc = proc;
	return proc as any;
});

mock.module("child_process", {
	namedExports: {
		...realChildProcess,
		spawn: mockSpawn,
		spawnSync: mockSpawnSync,
	},
});

const {
	projectRuntimeValue,
	projectToolArgs,
	projectToolFinalResult,
	projectToolPartialResult,
	projectToolResultDetails,
	sanitizeRuntimePayload,
	enforceRuntimeEventSize,
	spawnAgent,
} = await import("../taskplane/agent-host.ts");

let originalAppData = process.env.APPDATA;
let fakeAppDataRoot = "";

beforeEach(() => {
	mockSpawn.mock.resetCalls();
	mockSpawnSync.mock.resetCalls();
	lastSpawnedProc = null;
	fakeAppDataRoot = mkdtempSync(join(tmpdir(), "tp-runtime-projection-"));
	const fakeCliDir = join(fakeAppDataRoot, "npm", "node_modules", "@mariozechner", "pi-coding-agent", "dist");
	mkdirSync(fakeCliDir, { recursive: true });
	writeFileSync(join(fakeCliDir, "cli.js"), "// fake cli for tests\n", "utf-8");
	process.env.APPDATA = fakeAppDataRoot;
});

afterEach(() => {
	process.env.APPDATA = originalAppData;
	if (fakeAppDataRoot) rmSync(fakeAppDataRoot, { recursive: true, force: true });
	lastSpawnedProc = null;
});

describe("Runtime projection helpers", () => {
	it("returns the versioned projection schema and does not mutate inputs", () => {
		const input = { path: join(process.cwd(), "docs", "note.md"), content: "hello" };
		const original = { ...input };
		const projection = projectRuntimeValue(input);

		expect(projection.version).toBe(1);
		expect(projection.value).toEqual({ content: "hello", path: "docs/note.md" });
		expect(projection.truncated).toBe(false);
		expect(projection.redacted).toBe(false);
		expect(projection.visibleBytes).toBeGreaterThan(0);
		expect(projection.omittedPaths).toEqual([]);
		expect(projection.redactedPaths).toEqual([]);
		expect(input).toEqual(original);
	});

	it("redacts sensitive keys and string patterns", () => {
		const projection = projectRuntimeValue({
			apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
			content: "Authorization: Bearer token-abcdefghijklmnopqrstuvwxyz\nAPI_KEY=secret-value",
		});

		expect(JSON.stringify(projection.value)).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(JSON.stringify(projection.value)).not.toContain("secret-value");
		expect(projection.redacted).toBe(true);
		expect(projection.redactedPaths).toContain("$.apiKey");
		expect(projection.originalBytes).toBeUndefined();
	});

	it("enforces string, depth, array, object, cycle, and UTF-8-safe caps", () => {
		const cyclic: Record<string, unknown> = { name: "root" };
		cyclic.self = cyclic;
		const projection = projectRuntimeValue(
			{
				long: "🙂".repeat(10),
				array: [1, 2, 3],
				object: { a: 1, b: 2, c: 3 },
				deep: { next: { next: { next: "stop" } } },
				cyclic,
			},
			{ maxStringBytes: 9, maxArrayItems: 2, maxObjectKeys: 10, maxDepth: 3 },
		);

		const value = projection.value as Record<string, unknown>;
		expect(Buffer.byteLength(String(value.long), "utf8")).toBe(8);
		expect(projection.truncated).toBe(true);
		expect(projection.originalBytes).toBe(40);
		expect(projection.omittedPaths).toContain("$.long");
		expect(JSON.stringify(projection.value)).toContain("[Circular]");
		expect(JSON.stringify(projection.value)).toContain("[Omitted:max-depth]");

		const objectCap = projectRuntimeValue({ a: 1, b: 2, c: 3 }, { maxObjectKeys: 2 });
		expect((objectCap.value as Record<string, unknown>).c).toBeUndefined();
		expect(objectCap.omittedPaths).toContain("$.c");
	});

	it("truncates UTF-8 text on grapheme boundaries", () => {
		const projection = projectRuntimeValue({ text: "e\u0301e\u0301" }, { maxStringBytes: 4 });

		expect((projection.value as any).text).toBe("e\u0301");
		expect(projection.truncated).toBe(true);
	});

	it("enforces total projection size while preserving structural fields", () => {
		const projection = projectRuntimeValue(
			{ path: "docs/file.md", offset: 1, limit: 2, content: "x".repeat(1024) },
			{ maxTotalEventBytes: 120 },
		);

		expect((projection.value as any).path).toBe("docs/file.md");
		expect((projection.value as any).offset).toBe(1);
		expect((projection.value as any).limit).toBe(2);
		expect((projection.value as any).content).toBe("[Omitted:event-size-cap]");
		expect(projection.omittedPaths).toContain("$.content");
		expect(projection.visibleBytes).toBeLessThanOrEqual(120);
	});

	it("converts unsupported values predictably", () => {
		const projection = projectRuntimeValue({
			big: BigInt(10),
			fn: () => undefined,
			sym: Symbol("s"),
			buffer: Buffer.from("abc"),
			bytes: new Uint8Array([1, 2, 3]),
			date: new Date("2026-01-01T00:00:00.000Z"),
			re: /abc/g,
			error: new Error("Bearer token-abcdefghijklmnopqrstuvwxyz"),
			map: new Map([["a", 1]]),
		});

		expect(JSON.stringify(projection.value)).toContain("[BigInt]");
		expect(JSON.stringify(projection.value)).toContain("[Function]");
		expect(JSON.stringify(projection.value)).toContain("Uint8Array");
		expect(JSON.stringify(projection.value)).toContain("2026-01-01T00:00:00.000Z");
		expect(JSON.stringify(projection.value)).toContain("/abc/g");
		expect(JSON.stringify(projection.value)).toContain("[Map]");
		expect(JSON.stringify(projection.value)).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});

	it("projects tool args and result details with Pi-shaped fields", () => {
		expect((projectToolArgs("write", { path: "a.ts", content: "body", ignored: true })!.value as any).content).toBe("body");
		expect((projectToolArgs("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })!.value as any).edits[0].newText).toBe("b");
		expect((projectToolArgs("bash", { command: "npm test", timeout: 10 })!.value as any).command).toBe("npm test");
		expect((projectToolArgs("read", { path: "a.ts", offset: 1, limit: 2 })!.value as any).limit).toBe(2);
		expect((projectToolArgs("unknown", { path: "a.ts", value: "ok" })!.value as any).path).toBe("a.ts");

		const result = { content: [{ type: "text", text: "ok" }], details: { diff: "-a\n+b", patch: "patch", firstChangedLine: 4 } };
		expect(projectToolFinalResult("edit", result)).toBeDefined();
		expect((projectToolResultDetails("edit", result)!.value as any).firstChangedLine).toBe(4);
		expect(projectToolPartialResult("bash", { details: { output: "stream" } })).toBeDefined();
	});

	it("omits unsafe absolute paths and full output path metadata", () => {
		const projection = projectRuntimeValue({ path: "/Users/someone/.env", fullOutputPath: "/tmp/tool-output" });
		expect((projection.value as any).path).toBe("[omitted:absolute-path]");
		expect((projection.value as any).fullOutputPath).toBeUndefined();
		expect(projection.omittedPaths).toContain("$.path");
		expect(projection.omittedPaths).toContain("$.fullOutputPath");
	});

	it("sanitizes existing Runtime V2 payload fields", () => {
		const payload = sanitizeRuntimePayload("assistant_message", {
			text: "Cookie: session=secret\nhello",
			path: join(process.cwd(), "src", "index.ts"),
		}) as Record<string, unknown>;

		expect(String(payload.text)).toContain("[REDACTED:cookie]");
		expect(payload.path).toBe("src/index.ts");
	});

	it("preserves compact metadata when non-projection payloads exceed the event cap", () => {
		const event = enforceRuntimeEventSize({
			batchId: "batch-projection",
			agentId: "orch-test-lane-1-worker",
			role: "worker",
			laneNumber: 1,
			taskId: "TP-PROJ",
			repoId: "default",
			ts: Date.now(),
			type: "tool_output_update",
			payload: {
				streamId: "stream-1",
				messageId: "msg-1",
				tool: "bash",
				toolCallId: "call-1",
				displayMode: "terminal",
				isFinal: true,
				isError: false,
				content: "c".repeat(160 * 1024),
				text: "t".repeat(160 * 1024),
				output: "o".repeat(160 * 1024),
				summary: "s".repeat(160 * 1024),
			},
		});

		expect(event.payload.streamId).toBe("stream-1");
		expect(event.payload.messageId).toBe("msg-1");
		expect(event.payload.tool).toBe("bash");
		expect(event.payload.toolCallId).toBe("call-1");
		expect(event.payload.displayMode).toBe("terminal");
		expect(event.payload.isFinal).toBe(true);
		expect(event.payload.isError).toBe(false);
		expect(event.payload.content).toBeUndefined();
		expect(event.payload.text).toBeUndefined();
		expect(event.payload.summary).toBeUndefined();
		expect(event.payload.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(256 * 1024);
	});

	it("uses the provided cwd for legacy path sanitization", () => {
		const workspace = mkdtempSync(join(tmpdir(), "tp-path-projection-"));
		try {
			const payload = sanitizeRuntimePayload("tool_call", {
				path: join(workspace, "src", "index.ts"),
				argsProjection: projectToolArgs("read", { path: join(workspace, "src", "index.ts"), offset: 1, limit: 5 }, { cwd: workspace }),
			}, { cwd: workspace }) as Record<string, unknown>;

			expect(payload.path).toBe("src/index.ts");
			expect(((payload.argsProjection as any).value as any).path).toBe("src/index.ts");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("redacts sensitive payloads before text truncation and persistence helpers", () => {
		const privateKey = "-----BEGIN PRIVATE KEY-----\n" + "a".repeat(3000) + "\n-----END PRIVATE KEY-----";
		const samples: Array<[RuntimeAgentEvent["type"], Record<string, unknown>]> = [
			["assistant_message_update", { delta: `prefix ${privateKey} suffix` }],
			["assistant_thinking_update", { text: "thinking ghp_abcdefghijklmnopqrstuvwxyz123456" }],
			["retry_started", { error: "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz123456" }],
			["message_delivered", { content: "https://example.test?token=abcdefghijklmnopqrstuvwxyz" }],
			["reply_sent", { content: '{"token":"abcdefghijklmnopqrstuvwxyz123456"}' }],
			["escalation_sent", { content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }],
			["runtime_warning", { message: "Cookie: sid=secret" }],
			["tool_call", { tool: "bash", argsPreview: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'" }],
			["tool_result", { tool: "edit", text: privateKey, resultProjection: projectToolFinalResult("edit", { details: { diff: privateKey } }) }],
			["tool_result", { tool: "bash", text: "AKIA1234567890ABCDEF" }],
		];

		for (const [type, payload] of samples) {
			const sanitized = JSON.stringify(sanitizeRuntimePayload(type, payload));
			expect(sanitized).toContain("[REDACTED:");
			expect(sanitized).not.toContain("abcdefghijklmnopqrstuvwxyz");
			expect(sanitized).not.toContain("AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz123456");
			expect(sanitized).not.toContain("AKIA1234567890ABCDEF");
			expect(sanitized).not.toContain("-----BEGIN PRIVATE KEY-----");
		}
	});
});

describe("Runtime projection event persistence behavior", () => {
	it("omits oversized Pi RPC JSONL lines and recovers for later valid events", async () => {
		const events: RuntimeAgentEvent[] = [];
		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-1-worker",
				role: "worker",
				batchId: "batch-projection",
				laneNumber: 1,
				taskId: "TP-PROJ",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();
		lastSpawnedProc!.stdout.write("x".repeat(1024 * 1024 + 1));
		lastSpawnedProc!.stdout.write("\n" + JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const warning = events.find((event) => event.type === "runtime_warning");
		expect(warning).toBeDefined();
		expect(String(warning!.payload.message)).toBe("oversized Pi RPC JSONL line omitted");
		expect(JSON.stringify(warning!.payload)).not.toContain("xxx");
		expect(events.some((event) => event.type === "agent_exited")).toBe(true);
	});

	it("persists capped events and preserves projection metadata before content", async () => {
		const events: RuntimeAgentEvent[] = [];
		const dir = mkdtempSync(join(tmpdir(), "tp-runtime-events-"));
		const eventsPath = join(dir, "events.jsonl");
		try {
			const { promise } = spawnAgent(
				{
					agentId: "orch-test-lane-2-worker",
					role: "worker",
					batchId: "batch-projection",
					laneNumber: 2,
					taskId: "TP-PROJ",
					repoId: "default",
					cwd: dir,
					prompt: "run",
					mailboxDir: null,
					stateRoot: null,
					eventsPath,
				},
				(evt) => events.push(evt),
			);

			expect(lastSpawnedProc).toBeDefined();
			lastSpawnedProc!.stdout.write(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "custom_tool",
					toolCallId: "call-large-args",
					args: {
						path: join(dir, "docs", "large.md"),
						content: "x".repeat(100 * 1024),
						output: "y".repeat(100 * 1024),
						text: "z".repeat(100 * 1024),
						delta: "d".repeat(100 * 1024),
						snapshot: "s".repeat(100 * 1024),
						patch: "p".repeat(100 * 1024),
						diff: "f".repeat(100 * 1024),
						summary: "m".repeat(100 * 1024),
						command: "c".repeat(100 * 1024),
						metadata: { offset: 1, limit: 2 },
					},
				}) + "\n",
			);
			lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
			lastSpawnedProc!.emit("close", 0, null);

			await promise;

			const persisted = readFileSync(eventsPath, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as RuntimeAgentEvent);
			const toolCall = persisted.find((event) => event.type === "tool_call")!;
			const argsProjection = toolCall.payload.argsProjection as any;
			expect(argsProjection.value.path).toBe("docs/large.md");
			expect(argsProjection.value.content).toBe("[Omitted:event-size-cap]");
			expect(argsProjection.value.metadata.limit).toBe(2);
			expect(argsProjection.omittedPaths).toContain("$.content");
			expect(Buffer.byteLength(JSON.stringify(toolCall), "utf8")).toBeLessThanOrEqual(256 * 1024);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
