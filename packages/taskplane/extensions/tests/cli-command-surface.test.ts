/**
 * CLI command surface regression checks — TP-128
 *
 * Verifies removed TMUX installer command is no longer exposed.
 */

import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMailboxMessage, writeOutboxMessage } from "../taskplane/mailbox.ts";
import { loadMailboxView } from "../taskplane/cli-mailbox.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const CLI_PATH = resolve(PROJECT_ROOT, "bin", "taskplane.mjs");
const { formatAgentSnapshot } = await import(CLI_PATH);

function runCli(
	args: string[],
	cwd = PROJECT_ROOT,
): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout?.toString?.() ?? "",
			stderr: err.stderr?.toString?.() ?? "",
			exitCode: err.status ?? 1,
		};
	}
}

function makeHistoryFixture(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "taskplane-cli-history-"));
	mkdirSync(join(tempDir, ".pi"), { recursive: true });
	writeFileSync(
		join(tempDir, ".pi", "batch-history.json"),
		JSON.stringify([
			{
				batchId: "b1",
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1000,
				totalWaves: 1,
				totalTasks: 1,
				succeededTasks: 1,
				failedTasks: 0,
				skippedTasks: 0,
				blockedTasks: 0,
				tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				tasks: [],
				waves: [],
			},
		]),
		"utf-8",
	);
	return tempDir;
}

function makeMailboxFixture(): string {
	const tempDir = makeHistoryFixture();
	writeMailboxMessage(tempDir, "b1", "agent-1", {
		from: "supervisor",
		type: "steer",
		content: "finish the task",
	});
	writeOutboxMessage(tempDir, "b1", "agent-1", {
		from: "agent-1",
		type: "reply",
		content: "will do",
	});
	return tempDir;
}

function makeMessagingFixture(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "taskplane-cli-message-"));
	const batchId = "batch-1";
	mkdirSync(join(tempDir, ".pi", "runtime", batchId), { recursive: true });
	writeFileSync(
		join(tempDir, ".pi", "batch-state.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				phase: "executing",
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
		join(tempDir, ".pi", "runtime", batchId, "registry.json"),
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
						cwd: tempDir,
						packet: null,
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);
	return tempDir;
}

function addRuntimeAgentFixture(root: string, batchId = "b1"): void {
	mkdirSync(join(root, ".pi", "runtime", batchId, "lanes"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "runtime", batchId, "lanes", "lane-1.json"),
		JSON.stringify(
			{
				batchId,
				laneNumber: 1,
				taskId: "TASK-001",
				status: "complete",
				worker: {
					agentId: "agent-1",
					status: "exited",
					contextPct: 12.5,
					toolCalls: 3,
					inputTokens: 10,
					outputTokens: 2,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				progress: { currentStep: "Step 1", checked: 1, total: 1, iteration: 1 },
			},
			null,
			2,
		),
		"utf-8",
	);
}

describe("CLI command surface", () => {
	it("does not advertise install-tmux in help output", () => {
		const result = runCli(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("install-tmux");
	});

	it("advertises config command in help output", () => {
		const result = runCli(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("config");
		expect(result.stdout).toContain("--save-as-defaults");
	});

	it("advertises history and mailbox commands in help output", () => {
		const result = runCli(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("history");
		expect(result.stdout).toContain("mailbox");
		expect(result.stdout).toContain("replies");
		expect(result.stdout).toContain("tell");
		expect(result.stdout).toContain("broadcast");
	});

	it("prints command-specific help for history", () => {
		const result = runCli(["history", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("taskplane history");
		expect(result.stdout).toContain("--batch <id|latest>");
		expect(result.stdout).toContain("--agents");
	});

	it("prints command-specific help through help command", () => {
		const result = runCli(["help", "mailbox"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("taskplane mailbox");
		expect(result.stdout).toContain("--pending");
		expect(result.stdout).toContain("--json");
	});

	it("prints root help for help command help flag", () => {
		const result = runCli(["help", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("taskplane");
		expect(result.stdout).toContain("Commands:");
		expect(result.stderr).not.toContain("Unknown command");
	});

	it("prints messaging help without requiring message arguments", () => {
		const result = runCli(["tell", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("taskplane tell");
		expect(result.stdout).toContain("<agentId> <text>");
		expect(result.stderr).not.toContain("Usage: taskplane tell <agentId> <text>");
	});

	it("keeps exec deferred", () => {
		const result = runCli(["exec", "hello"]);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command: exec");
	});

	it("rejects install-tmux as an unknown command", () => {
		const result = runCli(["install-tmux"]);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command: install-tmux");
	});

	it("runs correctly when invoked via symlink path", (t) => {
		const tempDir = mkdtempSync(join(tmpdir(), "taskplane-cli-link-"));
		const linkPath = join(tempDir, "taskplane-link.mjs");

		try {
			symlinkSync(CLI_PATH, linkPath, "file");
		} catch (err: any) {
			if (err?.code === "EPERM" || err?.code === "EACCES") {
				t.skip(`Symlink creation not permitted in this environment (${err.code})`);
				return;
			}
			throw err;
		}

		try {
			const stdout = execFileSync("node", [linkPath, "help"], {
				cwd: PROJECT_ROOT,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("taskplane");
			expect(stdout).toContain("Usage:");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("formats new and legacy compaction snapshot counters", () => {
		expect(
			formatAgentSnapshot("lane worker", {
				status: "running",
				contextPct: 50,
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				compactionsStarted: 1,
				compactionsCompleted: 1,
			}),
		).toContain("compactions 1 started/1 completed");

		expect(
			formatAgentSnapshot("old worker", {
				status: "running",
				contextPct: 50,
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				compactions: 1,
			}),
		).toContain("compactions 1");
	});

	it("runs history against batch-history.json", () => {
		const tempDir = makeHistoryFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "history"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("Taskplane history - 1 batch");
			expect(stdout).toContain("b1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs history batch detail for latest", () => {
		const tempDir = makeHistoryFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "history", "--batch", "latest"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("Batch b1 - completed");
			expect(stdout).toContain("Tokens: 3 total");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prints history JSON", () => {
		const tempDir = makeHistoryFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "history", "--json"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const parsed = JSON.parse(stdout);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].batchId).toBe("b1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs mailbox against the latest batch", () => {
		const tempDir = makeMailboxFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "mailbox", "latest"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("Mailbox b1");
			expect(stdout).toContain("Pending inbox: 1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prints pending-only mailbox output", () => {
		const tempDir = makeMailboxFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "mailbox", "b1", "--pending"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("pending inbox");
			expect(stdout).not.toContain("processed outbox");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prints mailbox JSON", () => {
		const tempDir = makeMailboxFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "mailbox", "b1", "--json"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const parsed = JSON.parse(stdout);
			expect(parsed.batchId).toBe("b1");
			expect(parsed.agentIds).toContain("agent-1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prints mailbox replies", () => {
		const tempDir = makeMailboxFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "replies", "--batch", "b1"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("Replies b1");
			expect(stdout).toContain("will do");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves latest mailbox and replies from the active batch", () => {
		const tempDir = makeMessagingFixture();
		try {
			const mailbox = runCli(["mailbox", "latest"], tempDir);
			expect(mailbox.exitCode).toBe(0);
			expect(mailbox.stdout).toContain("Mailbox batch-1");

			const replies = runCli(["replies", "--batch", "latest"], tempDir);
			expect(replies.exitCode).toBe(0);
			expect(replies.stdout).toContain("Replies batch-1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs generated history and mailbox smoke commands", () => {
		const tempDir = makeMailboxFixture();
		try {
			addRuntimeAgentFixture(tempDir);
			const history = execFileSync("node", [CLI_PATH, "history", "--batch", "latest", "--agents"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(history).toContain("Batch b1 - completed");
			expect(history).toContain("Agents:");
			const mailbox = execFileSync("node", [CLI_PATH, "mailbox", "latest", "--json"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(JSON.parse(mailbox).batchId).toBe("b1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("sends tell messages through mailbox files", () => {
		const tempDir = makeMessagingFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "tell", "agent-1", "keep", "going"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("Message sent to agent-1");
			expect(loadMailboxView(tempDir, "batch-1").agents[0].inboxPending).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rate limits tell across CLI subprocess invocations", () => {
		const tempDir = makeMessagingFixture();
		try {
			const first = runCli(["tell", "agent-1", "keep", "going"], tempDir);
			expect(first.exitCode).toBe(0);

			const second = runCli(["tell", "agent-1", "again"], tempDir);
			expect(second.exitCode).toBe(1);
			expect(`${second.stdout}\n${second.stderr}`).toContain("Rate limited");
			expect(loadMailboxView(tempDir, "batch-1").agents[0].inboxPending).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("sends broadcast messages through mailbox files", () => {
		const tempDir = makeMessagingFixture();
		try {
			const stdout = execFileSync("node", [CLI_PATH, "broadcast", "heads", "up"], {
				cwd: tempDir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("Broadcast sent to 1 agent(s)");
			expect(loadMailboxView(tempDir, "batch-1").broadcast.pending).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rate limits broadcast across CLI subprocess invocations", () => {
		const tempDir = makeMessagingFixture();
		try {
			const first = runCli(["broadcast", "heads", "up"], tempDir);
			expect(first.exitCode).toBe(0);

			const second = runCli(["broadcast", "again"], tempDir);
			expect(second.exitCode).toBe(1);
			expect(`${second.stdout}\n${second.stderr}`).toContain("rate limited");
			expect(loadMailboxView(tempDir, "batch-1").broadcast.pending).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects tell for unknown agents", () => {
		const tempDir = makeMessagingFixture();
		try {
			const result = runCli(["tell", "missing", "keep going"], tempDir);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Unknown agent");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
