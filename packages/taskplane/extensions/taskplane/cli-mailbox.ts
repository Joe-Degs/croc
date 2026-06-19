import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	broadcastInboxDir,
	discoverMailboxAgentIds,
	mailboxRoot,
	readInbox,
	readOutbox,
	readOutboxHistory,
	sessionAckDir,
	sessionInboxDir,
} from "./mailbox.ts";
import type { MailboxMessage } from "./types.ts";
import { previewText } from "./cli-format.ts";

export interface MailboxAgentView {
	agentId: string;
	inboxPending: MailboxMessage[];
	inboxAcknowledged: MailboxMessage[];
	outboxPending: MailboxMessage[];
	outboxProcessed: MailboxMessage[];
}

export interface MailboxView {
	batchId: string;
	agentIds: string[];
	agents: MailboxAgentView[];
	broadcast: { pending: MailboxMessage[]; acknowledged: MailboxMessage[] };
	auditEvents: Array<Record<string, unknown>>;
}

export function loadMailboxView(stateRoot: string, batchId: string): MailboxView {
	const agentIds = discoverMailboxAgentIds(stateRoot, batchId).sort((a, b) => a.localeCompare(b));
	const agents = agentIds.map((agentId) => {
		const inboxPending = readInbox(sessionInboxDir(stateRoot, batchId, agentId), batchId).map(
			(entry) => entry.message,
		);
		const inboxAcknowledged = readInbox(sessionAckDir(stateRoot, batchId, agentId), batchId)
			.map((entry) => entry.message)
			.filter((message) => message.to === agentId);
		const outboxPending = readOutbox(stateRoot, batchId, agentId);
		const outboxProcessed = readOutboxHistory(stateRoot, batchId, agentId)
			.filter((entry) => entry.acked)
			.map((entry) => entry.message);
		return { agentId, inboxPending, inboxAcknowledged, outboxPending, outboxProcessed };
	});

	return {
		batchId,
		agentIds,
		agents,
		broadcast: loadBroadcastView(stateRoot, batchId, agentIds),
		auditEvents: readMailboxAuditEvents(stateRoot, batchId),
	};
}

function loadBroadcastView(
	stateRoot: string,
	batchId: string,
	agentIds: string[],
): { pending: MailboxMessage[]; acknowledged: MailboxMessage[] } {
	const pending: MailboxMessage[] = [];
	const acknowledged: MailboxMessage[] = [];
	for (const entry of readInbox(broadcastInboxDir(stateRoot, batchId), batchId)) {
		const ackedByAll =
			agentIds.length > 0 &&
			agentIds.every((agentId) =>
				existsSync(join(sessionAckDir(stateRoot, batchId, agentId), entry.filename)),
			);
		if (ackedByAll) acknowledged.push(entry.message);
		else pending.push(entry.message);
	}
	return { pending, acknowledged };
}

export function formatMailboxSummary(
	view: MailboxView,
	options: { agentId?: string; pending?: boolean } = {},
): string {
	const agents = filterAgents(view, options.agentId);
	const pendingInbox =
		sum(agents, (agent) => agent.inboxPending.length) + view.broadcast.pending.length;
	const ackedInbox =
		sum(agents, (agent) => agent.inboxAcknowledged.length) + view.broadcast.acknowledged.length;
	const outboxPending = sum(agents, (agent) => agent.outboxPending.length);
	const outboxProcessed = sum(agents, (agent) => agent.outboxProcessed.length);
	const lines = [
		`Mailbox ${view.batchId}`,
		`Agents: ${agents.length}`,
		`Pending inbox: ${pendingInbox}`,
		`Acknowledged inbox: ${ackedInbox}`,
		`Outbox pending: ${outboxPending}`,
		`Outbox processed: ${outboxProcessed} processed`,
		`Broadcast pending: ${view.broadcast.pending.length}`,
		`Broadcast acknowledged: ${view.broadcast.acknowledged.length}`,
		`Audit events: ${view.auditEvents.length}`,
	];

	for (const agent of agents) {
		lines.push("", `${agent.agentId}:`);
		appendMessages(lines, "pending inbox", agent.inboxPending);
		if (!options.pending) appendMessages(lines, "acknowledged inbox", agent.inboxAcknowledged);
		appendMessages(lines, "pending outbox", agent.outboxPending);
		if (!options.pending) appendMessages(lines, "processed outbox", agent.outboxProcessed);
	}

	if (
		view.broadcast.pending.length > 0 ||
		(!options.pending && view.broadcast.acknowledged.length > 0)
	) {
		lines.push("", "_broadcast:");
		appendMessages(lines, "pending inbox", view.broadcast.pending);
		if (!options.pending) appendMessages(lines, "acknowledged inbox", view.broadcast.acknowledged);
	}

	return lines.join("\n");
}

export function formatReplies(view: MailboxView, options: { agentId?: string } = {}): string {
	const agents = filterAgents(view, options.agentId);
	const lines = [`Replies ${view.batchId}`];
	let count = 0;
	for (const agent of agents) {
		const messages = [
			...agent.outboxPending.map((message) => ({ message, state: "pending" })),
			...agent.outboxProcessed.map((message) => ({ message, state: "processed" })),
		].sort((a, b) => a.message.timestamp - b.message.timestamp);
		if (messages.length === 0) continue;
		lines.push("", `${agent.agentId}:`);
		for (const entry of messages) {
			count++;
			lines.push(formatMessageLine(entry.state, entry.message));
		}
	}
	if (count === 0) lines.push("No agent replies found.");
	return lines.join("\n");
}

function filterAgents(view: MailboxView, agentId: string | undefined): MailboxAgentView[] {
	return agentId ? view.agents.filter((agent) => agent.agentId === agentId) : view.agents;
}

function appendMessages(lines: string[], label: string, messages: MailboxMessage[]): void {
	for (const message of messages) lines.push(formatMessageLine(label, message));
}

function formatMessageLine(label: string, message: MailboxMessage): string {
	const timestamp = new Date(message.timestamp).toISOString();
	return `- ${label}: ${message.id} ${message.type} ${message.from}->${message.to} ${timestamp} ${previewText(message.content, 120)}`;
}

function sum(agents: MailboxAgentView[], mapper: (agent: MailboxAgentView) => number): number {
	return agents.reduce((total, agent) => total + mapper(agent), 0);
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
