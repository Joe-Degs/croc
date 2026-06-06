/**
 * Conversation Event Fidelity Tests — TP-111
 *
 * Validates that the Runtime V2 agent-host emits prompt_sent,
 * assistant_message, and enriched tool events for dashboard rendering.
 *
 * Run: node --experimental-strip-types --experimental-test-module-mocks --no-warnings --import ./tests/loader.mjs --test tests/conversation-event-fidelity.test.ts
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import { expect } from "./expect.ts";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { PassThrough } from "stream";
import { EventEmitter } from "events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentHostSrc = readFileSync(join(__dirname, "..", "taskplane", "agent-host.ts"), "utf-8");
const dashboardAppSrc = readFileSync(
	join(__dirname, "..", "..", "dashboard", "public", "app.js"),
	"utf-8",
);

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
let onStdinWrite: ((chunk: string) => void) | null = null;

const realChildProcess = await import("node:child_process");
const mockSpawnSync = mock.fn(() => ({ stdout: "", stderr: "", status: 0 }) as any);
const mockSpawn = mock.fn((_cmd: string, _args?: readonly string[], _opts?: any) => {
	const proc = new EventEmitter() as FakeChildProc;
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.stdin = {
		destroyed: false,
		writes: [],
		write(chunk: string | Buffer) {
			const asText = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			this.writes.push(asText);
			if (onStdinWrite) onStdinWrite(asText);
			return true;
		},
		end() {
			this.destroyed = true;
		},
	};
	proc.pid = 43210;
	proc.kill = (_signal?: NodeJS.Signals | number) => true;
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

const { spawnAgent } = await import("../taskplane/agent-host.ts");

let originalAppData = process.env.APPDATA;
let fakeAppDataRoot = "";

beforeEach(() => {
	mockSpawn.mock.resetCalls();
	mockSpawnSync.mock.resetCalls();
	lastSpawnedProc = null;
	onStdinWrite = null;
	fakeAppDataRoot = mkdtempSync(join(tmpdir(), "tp111-agent-host-"));
	const fakeCliDir = join(
		fakeAppDataRoot,
		"npm",
		"node_modules",
		"@mariozechner",
		"pi-coding-agent",
		"dist",
	);
	mkdirSync(fakeCliDir, { recursive: true });
	writeFileSync(join(fakeCliDir, "cli.js"), "// fake cli for tests\n", "utf-8");
	process.env.APPDATA = fakeAppDataRoot;
});

afterEach(() => {
	process.env.APPDATA = originalAppData;
	if (fakeAppDataRoot) {
		try {
			rmSync(fakeAppDataRoot, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	lastSpawnedProc = null;
	onStdinWrite = null;
});

// ── 1. Agent-host conversation event emission ───────────────────────

describe("1.x: Agent-host emits conversation events (TP-111)", () => {
	it("1.1: emits prompt_sent after writing prompt to stdin", () => {
		// prompt_sent must be emitted after the prompt write
		const promptWriteIdx = agentHostSrc.indexOf('type: "prompt", message: opts.prompt');
		const promptSentIdx = agentHostSrc.indexOf('emitEvent("prompt_sent"');
		expect(promptWriteIdx).toBeGreaterThan(-1);
		expect(promptSentIdx).toBeGreaterThan(-1);
		expect(promptSentIdx).toBeGreaterThan(promptWriteIdx);
	});

	it("1.2: prompt_sent payload includes bounded text", () => {
		const emitIdx = agentHostSrc.indexOf('emitEvent("prompt_sent"');
		const block = agentHostSrc.slice(emitIdx, emitIdx + 200);
		expect(block).toContain("truncatePayload");
		expect(block).toContain("MAX_CONV_PAYLOAD_CHARS");
	});

	it("1.3: emits assistant_message on message_end with assistant role", () => {
		const msgEndIdx = agentHostSrc.indexOf('case "message_end"');
		const block = agentHostSrc.slice(msgEndIdx, msgEndIdx + 1500);
		expect(block).toContain('emitEvent("assistant_message"');
		expect(block).toContain("extractAssistantText");
	});

	it("1.4: assistant_message payload includes bounded text", () => {
		const emitIdx = agentHostSrc.indexOf('emitEvent("assistant_message"');
		const block = agentHostSrc.slice(emitIdx, emitIdx + 200);
		expect(block).toContain("truncatePayload");
		expect(block).toContain("MAX_CONV_PAYLOAD_CHARS");
	});

	it("1.5: tool_call event includes path and bounded argsPreview (no raw args)", () => {
		const emitIdx = agentHostSrc.indexOf('emitEvent("tool_call"');
		const block = agentHostSrc.slice(emitIdx, emitIdx + 200);
		expect(block).toContain("path:");
		expect(block).toContain("argsPreview:");
		// Must NOT contain raw args object
		expect(block).not.toContain("args: event.args");
	});

	it("1.6: tool_result event includes summary field", () => {
		const endIdx = agentHostSrc.indexOf('case "tool_execution_end"');
		const block = agentHostSrc.slice(endIdx, endIdx + 900);
		expect(block).toContain("summary:");
	});
});

// ── 2. Payload safety helpers ───────────────────────────────────────

describe("2.x: Payload safety (TP-111)", () => {
	it("2.1: MAX_CONV_PAYLOAD_CHARS is defined and reasonable", () => {
		expect(agentHostSrc).toContain("MAX_CONV_PAYLOAD_CHARS = 2000");
	});

	it("2.2: truncatePayload function exists", () => {
		expect(agentHostSrc).toContain("function truncatePayload");
	});

	it("2.3: extractAssistantText handles string content", () => {
		const fnIdx = agentHostSrc.indexOf("function extractAssistantText");
		const block = agentHostSrc.slice(fnIdx, fnIdx + 500);
		expect(block).toContain('typeof message.content === "string"');
	});

	it("2.4: extractAssistantText handles array content blocks with null guards", () => {
		const fnIdx = agentHostSrc.indexOf("function extractContentText");
		const block = agentHostSrc.slice(fnIdx, fnIdx + 600);
		expect(block).toContain("Array.isArray(content)");
		// Must guard against null/non-object entries
		expect(block).toContain("isRecord(block)");
	});
});

// ── 3. Dashboard renderer compatibility ─────────────────────────────

describe("3.x: Dashboard renders V2 conversation events (TP-111)", () => {
	it("3.1: worker feed handles assistant_message with payload text", () => {
		const fnIdx = dashboardAppSrc.indexOf("function renderWorkerFeedEvent");
		const block = dashboardAppSrc.slice(fnIdx, fnIdx + 4000);
		expect(block).toContain("'assistant_message'");
		expect(dashboardAppSrc).toContain("renderAssistantFeedEvent");
		expect(dashboardAppSrc).toContain("payloadText(payload, ['text', 'message'])");
	});

	it("3.2: worker feed handles prompt_sent with prompt text", () => {
		const fnIdx = dashboardAppSrc.indexOf("function renderWorkerFeedEvent");
		const block = dashboardAppSrc.slice(fnIdx, fnIdx + 4000);
		expect(block).toContain("'prompt_sent'");
		expect(dashboardAppSrc).toContain("renderPromptFeedEvent");
		expect(dashboardAppSrc).toContain("payloadText(payload, ['text', 'prompt', 'content'])");
	});

	it("3.3: worker feed handles tool_call with tool and path metadata", () => {
		const fnIdx = dashboardAppSrc.indexOf("function renderWorkerFeedEvent");
		const block = dashboardAppSrc.slice(fnIdx, fnIdx + 4000);
		expect(block).toContain("'tool_call'");
		expect(dashboardAppSrc).toContain("toolLabel(payload)");
		expect(dashboardAppSrc).toContain("payload.path");
	});

	it("3.4: worker feed handles tool_result with text, output, or summary", () => {
		const fnIdx = dashboardAppSrc.indexOf("function renderWorkerFeedEvent");
		const block = dashboardAppSrc.slice(fnIdx, fnIdx + 4000);
		expect(block).toContain("'tool_result'");
		expect(dashboardAppSrc).toContain("renderToolResultFeedEvent");
		expect(dashboardAppSrc).toContain(
			"payloadText(payload, ['text', 'outputDelta', 'output', 'summary'])",
		);
	});
});

// ── 4. Event type contract ──────────────────────────────────────────

describe("4.x: Event type contract (TP-111)", () => {
	const typesSrc = readFileSync(join(__dirname, "..", "taskplane", "types.ts"), "utf-8");

	it("4.1: prompt_sent is a valid RuntimeAgentEventType", () => {
		expect(typesSrc).toContain('"prompt_sent"');
	});

	it("4.2: assistant_message is a valid RuntimeAgentEventType", () => {
		expect(typesSrc).toContain('"assistant_message"');
	});

	it("4.3: tool_output_update is a valid RuntimeAgentEventType", () => {
		expect(typesSrc).toContain('"tool_output_update"');
	});
});

// ── 5. Runtime behavioral tests with mocked child process ───────────

describe("5.x: Runtime behavioral emission (TP-111)", () => {
	it("5.1: emits prompt_sent after prompt write and truncates conversation payloads", async () => {
		const events: RuntimeAgentEvent[] = [];
		const timeline: string[] = [];
		onStdinWrite = (chunk) => {
			if (chunk.includes('"type":"prompt"')) timeline.push("prompt_write");
		};

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-1-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 1,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "P".repeat(2200),
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => {
				events.push(evt);
				timeline.push(`event:${evt.type}`);
			},
		);

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(lastSpawnedProc).toBeDefined();

		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: "A".repeat(2600) },
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		expect(timeline.indexOf("prompt_write")).toBeGreaterThan(-1);
		expect(timeline.indexOf("event:prompt_sent")).toBeGreaterThan(timeline.indexOf("prompt_write"));

		const promptEvt = events.find((e) => e.type === "prompt_sent");
		const assistantEvt = events.find((e) => e.type === "assistant_message");
		expect(promptEvt).toBeDefined();
		expect(assistantEvt).toBeDefined();

		const promptText = String((promptEvt!.payload as any).text || "");
		const assistantText = String((assistantEvt!.payload as any).text || "");
		expect(promptText.length).toBe(2001); // 2000 + ellipsis
		expect(assistantText.length).toBe(2001); // 2000 + ellipsis
		expect(promptText.endsWith("…")).toBe(true);
		expect(assistantText.endsWith("…")).toBe(true);
	});

	it("5.2: emits bounded tool_call/tool_result payloads with no raw args object", async () => {
		const events: RuntimeAgentEvent[] = [];
		const huge = "X".repeat(5000);
		const longPath = `/tmp/${"p".repeat(400)}.txt`;

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-2-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 2,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();

		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "write",
				args: { content: huge, path: longPath },
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "write",
				result: huge,
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const toolCall = events.find((e) => e.type === "tool_call");
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolCall).toBeDefined();
		expect(toolResult).toBeDefined();

		const callPayload = toolCall!.payload as Record<string, unknown>;
		expect(callPayload["args"]).toBeUndefined();
		expect(String(callPayload["path"] || "").length).toBeLessThanOrEqual(200);
		expect(String(callPayload["argsPreview"] || "").length).toBeLessThanOrEqual(300);

		const resultPayload = toolResult!.payload as Record<string, unknown>;
		expect(String(resultPayload["summary"] || "").length).toBeLessThanOrEqual(200);
	});

	it("5.3: malformed assistant content arrays do not crash and still emit text blocks", async () => {
		const events: RuntimeAgentEvent[] = [];

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-3-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 3,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();

		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [null, { type: "text", text: "OK" }, undefined, 42, { type: "text" }],
				},
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const assistantEvt = events.find((e) => e.type === "assistant_message");
		expect(assistantEvt).toBeDefined();
		expect((assistantEvt!.payload as any).text).toBe("OK");
	});

	it("5.4: captures Pi tool result content text with metadata", async () => {
		const events: RuntimeAgentEvent[] = [];
		const output = "line 1\nline 2\nline 3";

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-4-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 4,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "bash",
				toolCallId: "call-bash-1",
				args: { command: "printf output" },
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "bash",
				toolCallId: "call-bash-1",
				isError: true,
				result: { content: [{ type: "text", text: output }] },
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const toolCall = events.find((e) => e.type === "tool_call");
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolCall).toBeDefined();
		expect(toolResult).toBeDefined();

		const callPayload = toolCall!.payload as Record<string, unknown>;
		expect(callPayload["toolCallId"]).toBe("call-bash-1");
		expect(callPayload["displayMode"]).toBe("terminal");

		const resultPayload = toolResult!.payload as Record<string, unknown>;
		expect(resultPayload["toolCallId"]).toBe("call-bash-1");
		expect(resultPayload["displayMode"]).toBe("terminal");
		expect(resultPayload["isError"]).toBe(true);
		expect(resultPayload["text"]).toBe(output);
		expect(resultPayload["summary"]).toBe(output);
	});

	it("5.5: emits bounded live output deltas instead of repeated cumulative output", async () => {
		const events: RuntimeAgentEvent[] = [];

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-5-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 5,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();
		for (const text of ["one\n", "one\ntwo\n", "one\ntwo\n"]) {
			lastSpawnedProc!.stdout.write(
				JSON.stringify({
					type: "tool_execution_update",
					toolName: "bash",
					toolCallId: "call-live-1",
					partialResult: { content: [{ type: "text", text }] },
				}) + "\n",
			);
		}
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const updates = events.filter((e) => e.type === "tool_output_update");
		expect(updates.length).toBe(2);
		expect(updates[0]!.payload["text"]).toBe("one\n");
		expect(updates[1]!.payload["text"]).toBe("two\n");
		expect(updates[0]!.payload["toolCallId"]).toBe("call-live-1");
	});

	it("5.6: caps per-event tool output at 16 KiB with byte truncation metadata", async () => {
		const events: RuntimeAgentEvent[] = [];
		const huge = "🙂".repeat(5 * 1024);

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-6-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 6,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "read",
				toolCallId: "call-read-1",
				result: { content: [{ type: "text", text: huge }] },
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		const payload = toolResult!.payload as Record<string, unknown>;
		expect(Buffer.byteLength(String(payload["text"]), "utf8")).toBe(16 * 1024);
		expect(String(payload["text"]).length).toBe(8 * 1024);
		expect(payload["truncated"]).toBe(true);
		expect(payload["originalBytes"]).toBe(20 * 1024);
		expect(payload["originalLength"]).toBeUndefined();
		expect(payload["displayMode"]).toBe("file");
	});

	it("5.7: captures toolResult message_end fallback without duplicate result events", async () => {
		const events: RuntimeAgentEvent[] = [];

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-7-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 7,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "bash",
				toolCallId: "call-fallback-1",
				result: { content: [{ type: "text", text: "primary" }] },
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "message_end",
				id: "envelope-message-end-1",
				message: {
					role: "toolResult",
					toolCallId: "call-fallback-1",
					content: [{ type: "text", text: "fallback" }],
				},
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "call-fallback-2",
					toolName: "read",
					content: [{ type: "text", text: "fallback only" }],
				},
			}) + "\n",
		);
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const results = events.filter((e) => e.type === "tool_result");
		expect(results.length).toBe(2);
		expect(results.map((e) => e.payload["toolCallId"]).join(",")).toBe(
			"call-fallback-1,call-fallback-2",
		);
		expect(results[0]!.payload["text"]).toBe("primary");
		expect(results[1]!.payload["text"]).toBe("fallback only");
		expect(results[1]!.payload["displayMode"]).toBe("file");
	});

	it("5.8: classifies edit tools as edit and unknown tools as summary", async () => {
		const events: RuntimeAgentEvent[] = [];

		const { promise } = spawnAgent(
			{
				agentId: "orch-test-lane-8-worker",
				role: "worker",
				batchId: "batch-tp111",
				laneNumber: 8,
				taskId: "TP-111",
				repoId: "default",
				cwd: process.cwd(),
				prompt: "run",
				mailboxDir: null,
				stateRoot: null,
			},
			(evt) => events.push(evt),
		);

		expect(lastSpawnedProc).toBeDefined();
		for (const [toolName, toolCallId] of [
			["edit", "call-edit-1"],
			["custom_tool", "call-custom-1"],
		] as const) {
			lastSpawnedProc!.stdout.write(
				JSON.stringify({
					type: "tool_execution_start",
					toolName,
					toolCallId,
					args: { path: "/tmp/file.txt", content: "content" },
				}) + "\n",
			);
		}
		lastSpawnedProc!.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
		lastSpawnedProc!.emit("close", 0, null);

		await promise;

		const calls = events.filter((e) => e.type === "tool_call");
		expect(calls[0]!.payload["displayMode"]).toBe("edit");
		expect(calls[1]!.payload["displayMode"]).toBe("summary");
	});
});
