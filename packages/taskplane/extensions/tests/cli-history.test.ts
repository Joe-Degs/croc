import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "./expect.ts";
import { formatDurationMs, formatTokenTotal, previewText } from "../taskplane/cli-format.ts";
import {
	formatBatchDetail,
	formatHistoryList,
	loadHistoryEntries,
	resolveHistoryBatch,
} from "../taskplane/cli-history.ts";

function makeHistoryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tp-cli-history-"));
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "batch-history.json"),
		JSON.stringify(
			[
				{
					batchId: "20260616T091535",
					status: "completed",
					startedAt: 1781601335364,
					endedAt: 1781604418478,
					durationMs: 3_083_114,
					totalWaves: 1,
					totalTasks: 1,
					succeededTasks: 1,
					failedTasks: 0,
					skippedTasks: 0,
					blockedTasks: 0,
					tokens: { input: 596_782, output: 6_398, cacheRead: 0, cacheWrite: 0 },
					tasks: [
						{
							taskId: "TASK-021",
							taskName: "Validate hard gates",
							status: "succeeded",
							wave: 1,
							lane: 1,
							durationMs: 3_083_114,
							tokens: { input: 596_782, output: 6_398, cacheRead: 0, cacheWrite: 0 },
							compactionsStarted: 0,
							compactionsCompleted: 0,
							exitReason: "Done",
						},
					],
					waves: [
						{
							wave: 1,
							tasks: ["TASK-021"],
							mergeStatus: "succeeded",
							durationMs: 3_083_114,
							tokens: { input: 596_782, output: 6_398, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			],
			null,
			2,
		),
		"utf-8",
	);
	return root;
}

describe("Taskplane CLI format helpers", () => {
	it("formats compact durations", () => {
		expect(formatDurationMs(3_083_114)).toBe("51m 23s");
		expect(formatDurationMs(750_166)).toBe("12m 30s");
		expect(formatDurationMs(-1)).toBe("unknown");
	});

	it("formats token totals with thousands separators", () => {
		expect(formatTokenTotal({ input: 596_782, output: 6_398, cacheRead: 0, cacheWrite: 0 })).toBe(
			"603,180",
		);
	});

	it("previews text on one line", () => {
		expect(previewText("hello\nworld", 20)).toBe("hello world");
		expect(previewText("x".repeat(200), 10)).toBe("xxxxxxxxxx...");
	});
});

describe("Taskplane CLI history", () => {
	it("loads history entries", () => {
		const root = makeHistoryRoot();
		try {
			expect(loadHistoryEntries(root)).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats compact history newest first", () => {
		const root = makeHistoryRoot();
		try {
			const text = formatHistoryList(loadHistoryEntries(root), { limit: 10 });
			expect(text).toContain("Taskplane history - 1 batch");
			expect(text).toContain("20260616T091535");
			expect(text).toContain("completed");
			expect(text).toContain("51m 23s");
			expect(text).toContain("603,180 tokens");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves latest and explicit batch ids", () => {
		const root = makeHistoryRoot();
		try {
			const history = loadHistoryEntries(root);
			expect(resolveHistoryBatch(history, "latest")?.batchId).toBe("20260616T091535");
			expect(resolveHistoryBatch(history, "20260616T091535")?.batchId).toBe("20260616T091535");
			expect(resolveHistoryBatch(history, "missing")).toBe(null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats batch detail", () => {
		const root = makeHistoryRoot();
		try {
			const entry = resolveHistoryBatch(loadHistoryEntries(root), "latest");
			if (!entry) throw new Error("missing fixture batch");
			const text = formatBatchDetail(root, entry, { agents: false, events: false });
			expect(text).toContain("Batch 20260616T091535 - completed");
			expect(text).toContain("Tasks: 1 succeeded, 0 failed, 0 skipped, 0 blocked / 1 total");
			expect(text).toContain("Tokens: 603,180 total");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats runtime agent detail when requested", () => {
		const root = makeHistoryRoot();
		try {
			mkdirSync(join(root, ".pi", "runtime", "20260616T091535", "lanes"), { recursive: true });
			writeFileSync(
				join(root, ".pi", "runtime", "20260616T091535", "lanes", "lane-1.json"),
				JSON.stringify(
					{
						batchId: "20260616T091535",
						laneNumber: 1,
						taskId: "TASK-021",
						status: "complete",
						worker: {
							agentId: "croc-operator-lane-1-worker",
							status: "exited",
							contextPct: 49.8,
							toolCalls: 35,
							inputTokens: 596_782,
							outputTokens: 6_398,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							compactionsStarted: 0,
							compactionsCompleted: 0,
						},
						progress: { currentStep: "Step 2: Verify hard gates", checked: 15, total: 15, iteration: 4 },
					},
					null,
					2,
				),
				"utf-8",
			);
			const entry = resolveHistoryBatch(loadHistoryEntries(root), "latest");
			if (!entry) throw new Error("missing fixture batch");
			const text = formatBatchDetail(root, entry, { agents: true, events: false });
			expect(text).toContain("Agents:");
			expect(text).toContain("croc-operator-lane-1-worker");
			expect(text).toContain("Step 2: Verify hard gates");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
