import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadBatchHistory } from "./persistence.ts";
import type { BatchHistorySummary } from "./types.ts";
import { formatDurationMs, formatNumber, formatTokenTotal } from "./cli-format.ts";

export interface HistoryListOptions {
	limit?: number;
}

export interface BatchDetailOptions {
	agents?: boolean;
	events?: boolean;
}

export function loadHistoryEntries(stateRoot: string): BatchHistorySummary[] {
	return loadBatchHistory(stateRoot);
}

export function formatHistoryList(
	history: BatchHistorySummary[],
	options: HistoryListOptions = {},
): string {
	if (history.length === 0) return "No Taskplane batch history found.";
	const limit = options.limit ?? history.length;
	const visible = history.slice(0, limit);
	const noun = history.length === 1 ? "batch" : "batches";
	const lines = [`Taskplane history - ${history.length} ${noun}`, ""];
	for (const entry of visible) {
		const ok = `${entry.succeededTasks}/${entry.totalTasks} ok`;
		const compactionsStarted = (entry.tasks ?? []).reduce(
			(sum, task) => sum + (task.compactionsStarted ?? 0),
			0,
		);
		const compactionsCompleted = (entry.tasks ?? []).reduce(
			(sum, task) => sum + (task.compactionsCompleted ?? 0),
			0,
		);
		const compactions =
			compactionsStarted > 0 || compactionsCompleted > 0
				? `${compactionsStarted}/${compactionsCompleted} compactions`
				: "0 compactions";
		const integrated = entry.integratedAt ? " integrated" : "";
		lines.push(
			`${entry.batchId}  ${entry.status.padEnd(9)}  ${formatDurationMs(entry.durationMs).padEnd(8)}  ${ok.padEnd(8)}  ${formatTokenTotal(entry.tokens)} tokens  ${compactions}${integrated}`,
		);
	}
	if (visible.length < history.length) {
		lines.push(
			"",
			`${formatNumber(history.length - visible.length)} older batch(es) hidden by --limit.`,
		);
	}
	return lines.join("\n");
}

export function resolveHistoryBatch(
	history: BatchHistorySummary[],
	batchId: string,
): BatchHistorySummary | null {
	if (batchId === "latest") return history[0] ?? null;
	return history.find((entry) => entry.batchId === batchId) ?? null;
}

export function formatBatchDetail(
	stateRoot: string,
	entry: BatchHistorySummary,
	options: BatchDetailOptions = {},
): string {
	const lines = [
		`Batch ${entry.batchId} - ${entry.status}`,
		`Started: ${new Date(entry.startedAt).toISOString()}`,
		`Duration: ${formatDurationMs(entry.durationMs)}`,
		`Tasks: ${entry.succeededTasks} succeeded, ${entry.failedTasks} failed, ${entry.skippedTasks} skipped, ${entry.blockedTasks} blocked / ${entry.totalTasks} total`,
		`Waves: ${entry.totalWaves}`,
		`Tokens: ${formatTokenTotal(entry.tokens)} total (${formatNumber(entry.tokens.input ?? 0)} in, ${formatNumber(entry.tokens.output ?? 0)} out, ${formatNumber(entry.tokens.cacheRead ?? 0)} cache read, ${formatNumber(entry.tokens.cacheWrite ?? 0)} cache write)`,
	];
	if (entry.integratedAt) lines.push(`Integrated: ${new Date(entry.integratedAt).toISOString()}`);
	if ((entry.waves ?? []).length > 0) {
		lines.push("", "Waves:");
		for (const wave of entry.waves) {
			lines.push(
				`- Wave ${wave.wave}: ${wave.tasks.join(", ")}, merge ${wave.mergeStatus}, ${formatDurationMs(wave.durationMs)}, ${formatTokenTotal(wave.tokens)} tokens`,
			);
		}
	}
	if ((entry.tasks ?? []).length > 0) {
		lines.push("", "Tasks:");
		for (const task of entry.tasks) {
			lines.push(
				`- ${task.taskId}: ${task.status}, wave ${task.wave}, lane ${task.lane}, ${formatDurationMs(task.durationMs)}, ${formatTokenTotal(task.tokens)} tokens`,
			);
			if (task.exitReason) lines.push(`  exit: ${task.exitReason}`);
		}
	}
	if (options.agents) appendAgentDetail(lines, stateRoot, entry.batchId);
	if (options.events) appendEventTimeline(lines, stateRoot, entry.batchId);
	return lines.join("\n");
}

function appendAgentDetail(lines: string[], stateRoot: string, batchId: string): void {
	const lanesDir = join(stateRoot, ".pi", "runtime", batchId, "lanes");
	const snapshots = readJsonFiles(lanesDir);
	if (snapshots.length === 0) return;
	lines.push("", "Agents:");
	for (const snapshot of snapshots) {
		const taskId = stringField(snapshot, "taskId");
		const lane = numberField(snapshot, "laneNumber");
		const label = taskId
			? `${taskId}${lane === undefined ? "" : ` lane ${lane}`}`
			: (stringField(snapshot, "sessionName") ?? "agent");
		appendAgentLine(lines, `${label} worker`, objectField(snapshot, "worker"));
		appendAgentLine(lines, `${label} reviewer`, objectField(snapshot, "reviewer"));
		appendAgentLine(lines, label, objectField(snapshot, "agent"));
		const progress = objectField(snapshot, "progress");
		if (progress) {
			const currentStep = stringField(progress, "currentStep");
			const checked = numberField(progress, "checked");
			const total = numberField(progress, "total");
			const iteration = numberField(progress, "iteration");
			const counts = checked !== undefined && total !== undefined ? ` (${checked}/${total})` : "";
			const iter = iteration !== undefined ? ` iteration ${iteration}` : "";
			if (currentStep) lines.push(`  progress: ${currentStep}${counts}${iter}`);
		}
	}
}

function appendAgentLine(
	lines: string[],
	label: string,
	agent: Record<string, unknown> | undefined,
): void {
	if (!agent) return;
	const agentId = stringField(agent, "agentId") ?? stringField(agent, "sessionName") ?? label;
	const status = stringField(agent, "status") ?? "unknown";
	const context = numberField(agent, "contextPct");
	const toolCalls = numberField(agent, "toolCalls");
	const inputTokens = numberField(agent, "inputTokens") ?? 0;
	const outputTokens = numberField(agent, "outputTokens") ?? 0;
	const cacheReadTokens = numberField(agent, "cacheReadTokens") ?? 0;
	const cacheWriteTokens = numberField(agent, "cacheWriteTokens") ?? 0;
	const compactionsStarted = numberField(agent, "compactionsStarted");
	const compactionsCompleted = numberField(agent, "compactionsCompleted");
	const contextText = context === undefined ? "ctx n/a" : `ctx ${context.toFixed(1)}%`;
	const tokens = formatNumber(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
	const compactions =
		compactionsStarted !== undefined || compactionsCompleted !== undefined
			? `, compactions ${compactionsStarted ?? 0} started/${compactionsCompleted ?? 0} completed`
			: "";
	const tools = toolCalls === undefined ? "" : `, tools ${toolCalls}`;
	lines.push(
		`- ${label}: ${agentId}, ${status}, ${contextText}${compactions}, ${tokens} tokens${tools}`,
	);
}

function appendEventTimeline(lines: string[], stateRoot: string, batchId: string): void {
	const eventsPath = join(stateRoot, ".pi", "supervisor", "events.jsonl");
	if (!existsSync(eventsPath)) return;
	const events = readJsonLines(eventsPath).filter(
		(event) => stringField(event, "batchId") === batchId,
	);
	if (events.length === 0) return;
	lines.push("", "Events:");
	for (const event of events) {
		const type = stringField(event, "type") ?? "event";
		if (type === "tool_output_update") continue;
		const timestamp = stringField(event, "timestamp") ?? "unknown time";
		const waveIndex = numberField(event, "waveIndex");
		const taskId = stringField(event, "taskId");
		const outcome =
			stringField(event, "outcome") ?? stringField(event, "phase") ?? stringField(event, "reason");
		const wave = waveIndex === undefined ? "" : ` wave ${waveIndex + 1}`;
		const task = taskId ? ` ${taskId}` : "";
		const suffix = outcome ? ` - ${outcome}` : "";
		lines.push(`- ${timestamp} ${type}${wave}${task}${suffix}`);
	}
}

function readJsonFiles(dir: string): Array<Record<string, unknown>> {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((fileName) => fileName.endsWith(".json"))
			.sort((a, b) => a.localeCompare(b))
			.map((fileName) => readJsonFile(join(dir, fileName)))
			.filter((value): value is Record<string, unknown> => value !== undefined);
	} catch {
		return [];
	}
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(filePath, "utf-8"));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(filePath, "utf-8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				try {
					const value = JSON.parse(line);
					return isRecord(value) ? value : undefined;
				} catch {
					return undefined;
				}
			})
			.filter((value): value is Record<string, unknown> => value !== undefined);
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(
	record: Record<string, unknown>,
	field: string,
): Record<string, unknown> | undefined {
	const value = record[field];
	return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
