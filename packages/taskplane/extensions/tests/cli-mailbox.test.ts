import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
	ackMessage,
	ackOutboxMessage,
	appendMailboxAuditEvent,
	_resetRateLimits,
	sessionAckDir,
	sessionInboxDir,
	writeBroadcastMessage,
	writeMailboxMessage,
	writeOutboxMessage,
} from "../taskplane/mailbox.ts";
import { loadMailboxView, formatMailboxSummary } from "../taskplane/cli-mailbox.ts";
import {
	broadcastMailboxMessageFromCli,
	sendMailboxMessageFromCli,
} from "../taskplane/cli-mailbox-commands.ts";

function writeActiveBatchFixture(root: string, batchId = "batch-1", phase = "executing"): void {
	mkdirSync(join(root, ".pi", "runtime", batchId), { recursive: true });
	writeFileSync(
		join(root, ".pi", "batch-state.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				phase,
				batchId,
				startedAt: 1,
				updatedAt: 2,
				endedAt: null,
				currentWaveIndex: 0,
				totalWaves: 1,
				totalTasks: 0,
				succeededTasks: 0,
				failedTasks: 0,
				skippedTasks: 0,
				blockedTasks: 0,
				wavePlan: [],
				lanes: [],
				tasks: [],
				mergeResults: [],
				blockedTaskIds: [],
				lastError: null,
				errors: [],
			},
			null,
			2,
		),
		"utf-8",
	);
	writeFileSync(
		join(root, ".pi", "runtime", batchId, "registry.json"),
		JSON.stringify(
			{
				batchId,
				updatedAt: Date.now(),
				agents: {
					"agent-1": {
						batchId,
						agentId: "agent-1",
						role: "worker",
						laneNumber: 1,
						taskId: "TASK-001",
						repoId: "repo",
						pid: process.pid,
						parentPid: process.pid,
						startedAt: Date.now(),
						status: "running",
						cwd: root,
						packet: null,
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);
}

describe("Taskplane CLI mailbox inspection", () => {
	beforeEach(() => {
		_resetRateLimits();
	});

	afterEach(() => {
		_resetRateLimits();
	});

	it("summarizes pending, acked, outbox, and audit counts", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-mailbox-"));
		try {
			const batchId = "batch-1";
			const agentId = "agent-1";
			writeMailboxMessage(root, batchId, agentId, {
				from: "supervisor",
				type: "steer",
				content: "fix it",
			});
			const acked = writeMailboxMessage(root, batchId, agentId, {
				from: "supervisor",
				type: "info",
				content: "already delivered",
			});
			const inboxDir = sessionInboxDir(root, batchId, agentId);
			writeOutboxMessage(root, batchId, agentId, {
				from: agentId,
				type: "escalate",
				content: "blocked",
			});
			const reply = writeOutboxMessage(root, batchId, agentId, {
				from: agentId,
				type: "reply",
				content: "done",
			});
			ackOutboxMessage(root, batchId, agentId, reply.id);
			appendMailboxAuditEvent(root, batchId, {
				type: "message_sent",
				from: "supervisor",
				to: agentId,
				messageType: "steer",
			});
			ackMessage(inboxDir, `${acked.id}.msg.json`);

			const view = loadMailboxView(root, batchId);
			expect(view.agentIds).toContain(agentId);
			const text = formatMailboxSummary(view, {});
			expect(text).toContain("Mailbox batch-1");
			expect(text).toContain("Pending inbox: 1");
			expect(text).toContain("Acknowledged inbox: 1");
			expect(text).toContain("processed");
			expect(text).toContain("Audit events: 1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes tell messages into an active agent inbox", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-tell-"));
		try {
			writeActiveBatchFixture(root);
			const result = sendMailboxMessageFromCli(root, "agent-1", "keep going", "steer");
			expect(result.ok).toBe(true);
			expect(loadMailboxView(root, "batch-1").agents[0].inboxPending).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses mailbox audit events for tell rate limiting after process reset", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-tell-rate-"));
		try {
			writeActiveBatchFixture(root);
			const first = sendMailboxMessageFromCli(root, "agent-1", "keep going", "steer");
			expect(first.ok).toBe(true);
			_resetRateLimits();

			const second = sendMailboxMessageFromCli(root, "agent-1", "again", "steer");

			expect(second.ok).toBe(false);
			expect(second.message).toContain("Rate limited");
			expect(loadMailboxView(root, "batch-1").agents[0].inboxPending).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects tell messages for unknown agents", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-tell-missing-"));
		try {
			writeActiveBatchFixture(root);
			const result = sendMailboxMessageFromCli(root, "missing-agent", "keep going", "steer");
			expect(result.ok).toBe(false);
			expect(result.message).toContain("Unknown agent");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects messaging terminal batches", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-tell-terminal-"));
		try {
			writeActiveBatchFixture(root, "batch-1", "completed");
			const result = sendMailboxMessageFromCli(root, "agent-1", "keep going", "steer");
			expect(result.ok).toBe(false);
			expect(result.message).toContain("terminal phase");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes broadcast messages for active agents", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-broadcast-"));
		try {
			writeActiveBatchFixture(root);
			const result = broadcastMailboxMessageFromCli(root, "heads up", "info");
			expect(result.ok).toBe(true);
			expect(loadMailboxView(root, "batch-1").broadcast.pending).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses mailbox audit events for broadcast rate limiting after process reset", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-broadcast-rate-"));
		try {
			writeActiveBatchFixture(root);
			const first = broadcastMailboxMessageFromCli(root, "heads up", "info");
			expect(first.ok).toBe(true);
			_resetRateLimits();

			const second = broadcastMailboxMessageFromCli(root, "again", "info");

			expect(second.ok).toBe(false);
			expect(second.message).toContain("rate limited");
			expect(loadMailboxView(root, "batch-1").broadcast.pending).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("counts broadcast ack markers from each agent", () => {
		const root = mkdtempSync(join(tmpdir(), "tp-cli-broadcast-ack-"));
		try {
			const batchId = "batch-1";
			const agentId = "agent-1";
			const message = writeBroadcastMessage(root, batchId, {
				from: "supervisor",
				type: "info",
				content: "all clear",
			});
			const ackDir = sessionAckDir(root, batchId, agentId);
			mkdirSync(ackDir, { recursive: true });
			writeFileSync(
				join(ackDir, `${message.id}.msg.json`),
				`${JSON.stringify(message, null, 2)}\n`,
				"utf-8",
			);

			const view = loadMailboxView(root, batchId);
			const text = formatMailboxSummary(view, {});

			expect(view.broadcast.pending).toHaveLength(0);
			expect(view.broadcast.acknowledged).toHaveLength(1);
			expect(text).toContain("Acknowledged inbox: 1");
			expect(text).toContain("Broadcast acknowledged: 1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
