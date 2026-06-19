import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendMailboxAuditEvent,
	checkRateLimit,
	mailboxRoot,
	RATE_LIMIT_WINDOW_MS,
	recordSend,
	writeBroadcastMessage,
	writeMailboxMessage,
} from "./mailbox.ts";
import { loadBatchState } from "./persistence.ts";
import { isProcessAlive, isTerminalStatus, readRegistrySnapshot } from "./process-registry.ts";
import { isBatchTerminal } from "./supervisor.ts";
import type { PersistedBatchState, RuntimeAgentManifest } from "./types.ts";

export type DirectCliMessageType = "steer" | "query" | "abort" | "info";
export type BroadcastCliMessageType = "steer" | "info" | "abort";
export type MailboxCommandResult = { ok: true; message: string } | { ok: false; message: string };
type ActiveBatchResult = { ok: true; batch: PersistedBatchState } | { ok: false; message: string };

const DIRECT_MESSAGE_TYPES = new Set<DirectCliMessageType>(["steer", "query", "abort", "info"]);
const BROADCAST_MESSAGE_TYPES = new Set<BroadcastCliMessageType>(["steer", "info", "abort"]);
const MESSAGEABLE_ROLES = new Set(["worker", "reviewer", "merger"]);

export function sendMailboxMessageFromCli(
	stateRoot: string,
	agentId: string,
	content: string,
	type: DirectCliMessageType = "steer",
): MailboxCommandResult {
	if (!DIRECT_MESSAGE_TYPES.has(type)) {
		return fail(`Invalid message type "${type}". Valid types: steer, query, abort, info.`);
	}
	if (content.trim().length === 0) return fail("Message content is required.");

	const state = loadActiveBatchState(stateRoot);
	if (state.ok === false) return state;

	const manifest = readRegistrySnapshot(stateRoot, state.batch.batchId)?.agents[agentId];
	if (!manifest) return fail(`Unknown agent "${agentId}" in batch ${state.batch.batchId}.`);
	if (!isLiveMessageableAgent(manifest)) {
		return fail(`Agent "${agentId}" is not currently running.`);
	}

	const rateCheck = checkCliRateLimit(stateRoot, state.batch.batchId, agentId);
	if (!rateCheck.allowed) {
		appendMailboxAuditEvent(stateRoot, state.batch.batchId, {
			type: "message_rate_limited",
			from: "supervisor",
			to: agentId,
			reason: "per-agent rate limit",
			retryAfterMs: rateCheck.retryAfterMs,
		});
		return fail(
			`Rate limited: wait ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s before sending another message to ${agentId}.`,
		);
	}

	try {
		const message = writeMailboxMessage(stateRoot, state.batch.batchId, agentId, {
			from: "supervisor",
			type,
			content,
		});
		recordSend(agentId);
		appendMailboxAuditEvent(stateRoot, state.batch.batchId, {
			type: "message_sent",
			from: "supervisor",
			to: agentId,
			messageId: message.id,
			messageType: type,
			contentPreview: content.slice(0, 200),
			broadcast: false,
		});
		return ok(`Message sent to ${agentId} (batch ${state.batch.batchId}, id ${message.id}).`);
	} catch (error) {
		return fail(`Failed to write message: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function broadcastMailboxMessageFromCli(
	stateRoot: string,
	content: string,
	type: BroadcastCliMessageType = "info",
): MailboxCommandResult {
	if (!BROADCAST_MESSAGE_TYPES.has(type)) {
		return fail(`Invalid broadcast type "${type}". Valid types: steer, info, abort.`);
	}
	if (content.trim().length === 0) return fail("Broadcast content is required.");

	const state = loadActiveBatchState(stateRoot);
	if (state.ok === false) return state;

	const recipients = collectLiveAgentIds(stateRoot, state.batch.batchId);
	if (recipients.length === 0) {
		return fail(`No active agents found in batch ${state.batch.batchId}.`);
	}

	const blocked = recipients
		.map((agentId) => ({
			agentId,
			check: checkCliRateLimit(stateRoot, state.batch.batchId, agentId),
		}))
		.filter(({ check }) => !check.allowed);
	if (blocked.length > 0) {
		for (const entry of blocked) {
			appendMailboxAuditEvent(stateRoot, state.batch.batchId, {
				type: "message_rate_limited",
				from: "supervisor",
				to: entry.agentId,
				reason: "broadcast blocked by per-agent rate limit",
				retryAfterMs: entry.check.retryAfterMs,
			});
		}
		return fail(`Broadcast rate limited for ${blocked.length}/${recipients.length} agent(s).`);
	}

	try {
		const message = writeBroadcastMessage(stateRoot, state.batch.batchId, {
			from: "supervisor",
			type,
			content,
		});
		for (const agentId of recipients) recordSend(agentId);
		appendMailboxAuditEvent(stateRoot, state.batch.batchId, {
			type: "message_sent",
			from: "supervisor",
			to: "_broadcast",
			messageId: message.id,
			messageType: type,
			contentPreview: content.slice(0, 200),
			broadcast: true,
			recipients,
		});
		return ok(
			`Broadcast sent to ${recipients.length} agent(s) (batch ${state.batch.batchId}, id ${message.id}).`,
		);
	} catch (error) {
		return fail(`Failed to broadcast: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function loadActiveBatchState(stateRoot: string): ActiveBatchResult {
	let batch: PersistedBatchState | null;
	try {
		batch = loadBatchState(stateRoot);
	} catch (error) {
		return fail(
			`Failed to load batch state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!batch) return fail("No active batch state found.");
	if (isBatchTerminal(batch.phase)) {
		return fail(`Batch ${batch.batchId} is in terminal phase (${batch.phase}).`);
	}
	return { ok: true, batch };
}

function collectLiveAgentIds(stateRoot: string, batchId: string): string[] {
	const registry = readRegistrySnapshot(stateRoot, batchId);
	if (!registry) return [];
	return Object.values(registry.agents)
		.filter(isLiveMessageableAgent)
		.map((manifest) => manifest.agentId)
		.sort((a, b) => a.localeCompare(b));
}

function checkCliRateLimit(
	stateRoot: string,
	batchId: string,
	agentId: string,
): { allowed: boolean; retryAfterMs?: number } {
	const memory = checkRateLimit(agentId);
	const durable = checkAuditRateLimit(stateRoot, batchId, agentId);
	if (memory.allowed && durable.allowed) return { allowed: true };
	return {
		allowed: false,
		retryAfterMs: Math.max(memory.retryAfterMs ?? 0, durable.retryAfterMs ?? 0),
	};
}

function checkAuditRateLimit(
	stateRoot: string,
	batchId: string,
	agentId: string,
	windowMs = RATE_LIMIT_WINDOW_MS,
): { allowed: boolean; retryAfterMs?: number } {
	let lastSent = 0;
	for (const event of readMailboxAuditEvents(stateRoot, batchId)) {
		if (event.type !== "message_sent") continue;
		const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0;
		if (ts <= lastSent) continue;
		if (event.to === agentId) {
			lastSent = ts;
			continue;
		}
		if (event.broadcast === true && broadcastEventTargetsAgent(event, agentId)) lastSent = ts;
	}
	if (lastSent === 0) return { allowed: true };

	const elapsed = Math.max(0, Date.now() - lastSent);
	if (elapsed >= windowMs) return { allowed: true };
	return { allowed: false, retryAfterMs: windowMs - elapsed };
}

function broadcastEventTargetsAgent(event: Record<string, unknown>, agentId: string): boolean {
	if (Array.isArray(event.recipients)) return event.recipients.includes(agentId);
	return event.to === "_broadcast";
}

function readMailboxAuditEvents(
	stateRoot: string,
	batchId: string,
): Array<Record<string, unknown>> {
	const eventsPath = join(mailboxRoot(stateRoot, batchId), "events.jsonl");
	if (!existsSync(eventsPath)) return [];
	try {
		return readFileSync(eventsPath, "utf-8")
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

function isLiveMessageableAgent(manifest: RuntimeAgentManifest): boolean {
	return (
		MESSAGEABLE_ROLES.has(manifest.role) &&
		!isTerminalStatus(manifest.status) &&
		isProcessAlive(manifest.pid)
	);
}

function ok(message: string): { ok: true; message: string } {
	return { ok: true, message };
}

function fail(message: string): { ok: false; message: string } {
	return { ok: false, message };
}
