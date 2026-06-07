import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { expect } from "./expect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");
const dashboardServerPath = join(packageRoot, "dashboard", "server.cjs");

const cleanupFns: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	while (cleanupFns.length > 0) {
		const cleanup = cleanupFns.pop();
		if (cleanup) await cleanup();
	}
});

function writeJsonl(filePath: string, events: Array<Record<string, unknown>>) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function writeBatchState(root: string, batchId: string) {
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, ".pi", "batch-state.json"), JSON.stringify({ batchId }));
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				server.close(() => reject(new Error("Expected TCP server address")));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

async function startDashboard(root: string): Promise<{ baseUrl: string; proc: ChildProcess }> {
	const port = await getFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const proc = spawn(
		process.execPath,
		[dashboardServerPath, "--root", root, "--host", "127.0.0.1", "--port", String(port), "--no-open"],
		{ cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
	);

	let stdout = "";
	let stderr = "";
	proc.stdout?.on("data", (chunk) => {
		stdout += String(chunk);
	});
	proc.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});

	cleanupFns.push(
		() =>
			new Promise<void>((resolve) => {
				if (proc.exitCode !== null || proc.signalCode !== null) {
					resolve();
					return;
				}
				proc.once("exit", () => resolve());
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				}, 1000).unref();
			}),
	);

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Dashboard server did not start. stdout=${stdout} stderr=${stderr}`));
		}, 5000);
		const onExit = () => {
			clearTimeout(timeout);
			reject(new Error(`Dashboard server exited early. stdout=${stdout} stderr=${stderr}`));
		};
		proc.once("exit", onExit);
		const interval = setInterval(() => {
			if (stdout.includes(baseUrl)) {
				clearTimeout(timeout);
				clearInterval(interval);
				proc.off("exit", onExit);
				resolve();
			}
		}, 25);
	});

	return { baseUrl, proc };
}

async function request(baseUrl: string, path: string): Promise<{ status: number; text: string }> {
	const response = await fetch(`${baseUrl}${path}`);
	return { status: response.status, text: await response.text() };
}

async function requestJson(baseUrl: string, path: string): Promise<Array<Record<string, unknown>>> {
	const response = await request(baseUrl, path);
	expect(response.status).toBe(200);
	return JSON.parse(response.text) as Array<Record<string, unknown>>;
}

async function requestJsonValue(baseUrl: string, path: string): Promise<Record<string, unknown>> {
	const response = await request(baseUrl, path);
	expect(response.status).toBe(200);
	return JSON.parse(response.text) as Record<string, unknown>;
}

function makeTempRoot() {
	const root = mkdtempSync(join(tmpdir(), "tp-agent-events-"));
	cleanupFns.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

describe("dashboard agent events endpoint", () => {
	it("loads current-batch agent events when batchId query is absent", async () => {
		const root = makeTempRoot();
		writeBatchState(root, "batch-current");
		writeJsonl(join(root, ".pi", "runtime", "batch-current", "agents", "agent-1", "events.jsonl"), [
			{ type: "agent_started", ts: 1000, payload: { source: "current" } },
		]);

		const { baseUrl } = await startDashboard(root);
		const events = await requestJson(baseUrl, "/api/agent-events/agent-1");

		expect(events).toHaveLength(1);
		expect(events[0].payload).toEqual({ source: "current" });
	});

	it("loads historical agent events from the requested batchId", async () => {
		const root = makeTempRoot();
		writeBatchState(root, "batch-current");
		writeJsonl(join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"), [
			{ type: "tool_result", ts: 2000, payload: { source: "historical" } },
		]);

		const { baseUrl } = await startDashboard(root);
		const events = await requestJson(baseUrl, "/api/agent-events/agent-1?batchId=batch-old");

		expect(events).toHaveLength(1);
		expect(events[0].payload).toEqual({ source: "historical" });
	});

	it("keeps sinceTs filtering for historical event reads", async () => {
		const root = makeTempRoot();
		writeJsonl(join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"), [
			{ type: "early", ts: 1000 },
			{ type: "late", ts: 3000 },
		]);

		const { baseUrl } = await startDashboard(root);
		const events = await requestJson(
			baseUrl,
			"/api/agent-events/agent-1?batchId=batch-old&sinceTs=1500",
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("late");
	});

	it("returns a cursor envelope with only sequenced events after afterSeq", async () => {
		const root = makeTempRoot();
		writeJsonl(join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"), [
			{ type: "old", ts: 1000 },
			{ seq: 3, type: "third", ts: 3000 },
			{ seq: 2, type: "second", ts: 2000 },
			{ seq: 3, type: "third-duplicate", ts: 3001 },
			{ seq: "4", type: "invalid-string", ts: 4000 },
			{ seq: 5, type: "fifth", ts: 5000 },
		]);

		const { baseUrl } = await startDashboard(root);
		const envelope = await requestJsonValue(baseUrl, "/api/agent-events/agent-1?batchId=batch-old&afterSeq=2");

		expect((envelope.events as Array<Record<string, unknown>>).map((event) => event.type)).toEqual([
			"third",
			"third-duplicate",
			"fifth",
		]);
		expect(envelope.minSeq).toBe(2);
		expect(envelope.maxSeq).toBe(5);
		expect(envelope.hasMore).toBe(false);
		expect(envelope.cursorSatisfied).toBe(true);
		expect(envelope.resetRequired).toBe(false);
	});

	it("keeps unsequenced events in no-cursor best-effort mode", async () => {
		const root = makeTempRoot();
		writeJsonl(join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"), [
			{ type: "old", ts: 1000 },
			{ seq: 1, type: "new", ts: 2000 },
		]);

		const { baseUrl } = await startDashboard(root);
		const events = await requestJson(baseUrl, "/api/agent-events/agent-1?batchId=batch-old");

		expect(events.map((event) => event.type)).toEqual(["old", "new"]);
	});

	it("rejects malformed afterSeq values", async () => {
		const root = makeTempRoot();
		const { baseUrl } = await startDashboard(root);
		const invalidValues = ["1.5", "NaN", "Infinity", "-1", "9007199254740992", "%20", "%201", "1%20", "123abc"];

		for (const value of invalidValues) {
			const response = await request(baseUrl, `/api/agent-events/agent-1?batchId=batch-old&afterSeq=${value}`);
			expect(response.status).toBe(400);
			expect(response.text).toBe("Invalid afterSeq");
		}
	});

	it("signals reset when afterSeq is older than the readable sequenced tail", async () => {
		const root = makeTempRoot();
		writeJsonl(join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"), [
			{ seq: 10, type: "tail-start", ts: 1000 },
			{ seq: 11, type: "tail-end", ts: 2000 },
		]);

		const { baseUrl } = await startDashboard(root);
		const envelope = await requestJsonValue(baseUrl, "/api/agent-events/agent-1?batchId=batch-old&afterSeq=0");

		expect(envelope.minSeq).toBe(10);
		expect(envelope.maxSeq).toBe(11);
		expect(envelope.cursorSatisfied).toBe(false);
		expect(envelope.resetRequired).toBe(true);
		expect((envelope.events as Array<Record<string, unknown>>).map((event) => event.type)).toEqual(["tail-start", "tail-end"]);
	});

	it("returns a stable empty cursor envelope for unsequenced files", async () => {
		const root = makeTempRoot();
		writeJsonl(join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"), [
			{ type: "old", ts: 1000 },
		]);

		const { baseUrl } = await startDashboard(root);
		const envelope = await requestJsonValue(baseUrl, "/api/agent-events/agent-1?batchId=batch-old&afterSeq=0");

		expect(envelope).toEqual({
			events: [],
			minSeq: null,
			maxSeq: null,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});
	});

	it("reads the highest valid existing sequence for append reuse", async () => {
		const root = makeTempRoot();
		const eventsPath = join(root, "events.jsonl");
		writeFileSync(
			eventsPath,
			[
				JSON.stringify({ type: "old" }),
				"not json",
				JSON.stringify({ seq: 2, type: "valid" }),
				JSON.stringify({ seq: "99", type: "invalid" }),
				JSON.stringify({ seq: 7, type: "highest" }),
				JSON.stringify({ seq: 4, type: "lower" }),
			].join("\n"),
		);
		const { readHighestRuntimeEventSeq } = await import("../taskplane/agent-host.ts");

		expect(readHighestRuntimeEventSeq(eventsPath)).toBe(7);
	});

	it("rejects invalid agent IDs", async () => {
		const root = makeTempRoot();
		const { baseUrl } = await startDashboard(root);

		const dotAgent = await request(baseUrl, "/api/agent-events/agent.one");
		const slashAgent = await request(baseUrl, "/api/agent-events/agent%2Fone");

		expect(dotAgent.status).toBe(400);
		expect(dotAgent.text).toBe("Invalid agent ID");
		expect(slashAgent.status).toBe(400);
		expect(slashAgent.text).toBe("Invalid agent ID");
	});

	it("rejects dot-only and traversal-like batch IDs", async () => {
		const root = makeTempRoot();
		const { baseUrl } = await startDashboard(root);
		const invalidBatchIds = [
			".",
			"..",
			"...",
			"..%2Fbatch-old",
			"batch%2Fold",
			"-batch",
			"batch-",
			".batch",
			"batch.",
		];

		for (const batchId of invalidBatchIds) {
			const response = await request(baseUrl, `/api/agent-events/agent-1?batchId=${batchId}`);
			expect(response.status).toBe(400);
			expect(response.text).toBe("Invalid batch ID");
		}
	});

	it("returns an empty array for valid missing historical event files", async () => {
		const root = makeTempRoot();
		const { baseUrl } = await startDashboard(root);

		const events = await requestJson(baseUrl, "/api/agent-events/agent-1?batchId=batch-missing");

		expect(events).toEqual([]);
	});

	it("does not follow an agent events symlink outside runtime", async () => {
		const root = makeTempRoot();
		const outside = makeTempRoot();
		const outsideEventsPath = join(outside, "events.jsonl");
		writeJsonl(outsideEventsPath, [
			{ type: "outside", ts: 1000, payload: { secret: "not-runtime" } },
		]);
		const eventsPath = join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl");
		mkdirSync(dirname(eventsPath), { recursive: true });
		symlinkSync(outsideEventsPath, eventsPath);

		const { baseUrl } = await startDashboard(root);
		const events = await requestJson(baseUrl, "/api/agent-events/agent-1?batchId=batch-old");

		expect(events).toEqual([]);
	});

	it("caps responses at the last 300 events", async () => {
		const root = makeTempRoot();
		const events = Array.from({ length: 305 }, (_, index) => ({
			type: "event",
			ts: index,
			seq: index,
		}));
		writeJsonl(
			join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl"),
			events,
		);

		const { baseUrl } = await startDashboard(root);
		const responseEvents = await requestJson(baseUrl, "/api/agent-events/agent-1?batchId=batch-old");

		expect(responseEvents).toHaveLength(300);
		expect(responseEvents[0].seq).toBe(5);
		expect(responseEvents[299].seq).toBe(304);
	});

	it("loads the tail of oversized event files without reading the whole file", async () => {
		const root = makeTempRoot();
		const eventsPath = join(root, ".pi", "runtime", "batch-old", "agents", "agent-1", "events.jsonl");
		mkdirSync(dirname(eventsPath), { recursive: true });
		writeFileSync(
			eventsPath,
			`${JSON.stringify({ type: "huge", ts: 1, payload: "x".repeat(2 * 1024 * 1024 + 1024) })}\n${JSON.stringify({ type: "tail", ts: 2 })}\n`,
		);

		const { baseUrl } = await startDashboard(root);
		const responseEvents = await requestJson(baseUrl, "/api/agent-events/agent-1?batchId=batch-old");

		expect(responseEvents).toHaveLength(1);
		expect(responseEvents[0].type).toBe("tail");
	});
});
