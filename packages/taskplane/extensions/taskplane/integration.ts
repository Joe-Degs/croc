/**
 * CLI-safe Taskplane integration helpers.
 *
 * This module deliberately avoids importing the Pi extension runtime. The Pi
 * extension and the standalone Taskplane CLI can both use these helpers without
 * pulling in Pi-only packages.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { cleanupPostIntegrate } from "./cleanup.ts";
import { getCurrentBranch, runGit } from "./git.ts";
import { deleteBatchState, updateBatchHistoryIntegration } from "./persistence.ts";
import type { CiDeps, IntegrationExecutor } from "./supervisor.ts";
import { deleteStaleBranches } from "./worktree.ts";

export type IntegrateMode = "ff" | "merge" | "pr";

export interface IntegrationContext {
	orchBranch: string;
	baseBranch: string;
	batchId: string;
	currentBranch: string;
	notices: string[];
}

export interface IntegrationResult {
	success: boolean;
	integratedLocally: boolean;
	commitCount: string;
	message: string;
	error?: string;
}

export interface IntegrationExecDeps {
	runGit: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
	runCommand: (cmd: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };
	deleteBatchState: () => void;
}

interface BatchHistorySnapshot {
	filePath: string;
	raw: string;
}

export function withPreservedBatchHistory<T>(stateRoot: string, operation: () => T): T {
	const historyPath = join(stateRoot, ".pi", "batch-history.json");
	let snapshot: BatchHistorySnapshot | null = null;
	try {
		if (existsSync(historyPath)) {
			snapshot = {
				filePath: historyPath,
				raw: readFileSync(historyPath, "utf-8"),
			};
		}
	} catch {
		// Best effort only.
	}

	try {
		return operation();
	} finally {
		if (snapshot) {
			try {
				const dir = dirname(snapshot.filePath);
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				const tmpPath = `${snapshot.filePath}.tmp`;
				writeFileSync(tmpPath, snapshot.raw);
				renameSync(tmpPath, snapshot.filePath);
			} catch {
				// Never block integration completion on sidecar history restore.
			}
		}
	}
}

export function executeIntegration(
	mode: IntegrateMode,
	context: IntegrationContext,
	deps: IntegrationExecDeps,
): IntegrationResult {
	const { orchBranch, currentBranch, batchId } = context;

	const alreadyMergedCheck = deps.runGit(["merge-base", "--is-ancestor", orchBranch, "HEAD"]);
	if (alreadyMergedCheck.ok) {
		return performCleanup(deps, orchBranch, {
			success: true,
			integratedLocally: true,
			commitCount: "0",
			message:
				`Already integrated, all task work is present in ${currentBranch}.\n\n` +
				`The orch branch was merged manually before this command ran. No additional merge was needed.\n\n` +
				`Running cleanup: removing orch branch and clearing batch state.`,
			error: "",
		});
	}

	if (mode === "ff") {
		let stashed = false;
		const statusCheck = deps.runGit(["status", "--porcelain"]);
		if (statusCheck.ok && statusCheck.stdout.trim()) {
			deps.runGit(["stash", "push", "--include-untracked", "-m", `orch-integrate-autostash-${batchId}`]);
			stashed = true;
		}

		const result = deps.runGit(["merge", "--ff-only", orchBranch]);
		if (stashed) deps.runGit(["stash", "pop"]);

		if (!result.ok) {
			const protectionHint =
				result.stderr.includes("protected") || result.stderr.includes("permission")
					? `\n\n  If the branch is protected, use --pr to create a pull request.`
					: "";
			return {
				success: false,
				integratedLocally: false,
				commitCount: "0",
				message: "",
				error:
					`Fast-forward failed, branches have diverged.\n` +
					`${result.stderr}\n\n` +
					`Try:\n` +
					`  taskplane integrate --merge    Create a merge commit\n` +
					`  taskplane integrate --pr       Create a pull request instead` +
					protectionHint,
			};
		}

		return performCleanup(deps, orchBranch, {
			success: true,
			integratedLocally: true,
			commitCount: "?",
			message: `Fast-forwarded ${currentBranch} to ${orchBranch}.`,
		});
	}

	if (mode === "merge") {
		let mergeStashed = false;
		const mergeStatusCheck = deps.runGit(["status", "--porcelain"]);
		if (mergeStatusCheck.ok && mergeStatusCheck.stdout.trim()) {
			deps.runGit(["stash", "push", "--include-untracked", "-m", `orch-integrate-autostash-${batchId}`]);
			mergeStashed = true;
		}

		const result = deps.runGit(["merge", orchBranch, "--no-edit"]);
		if (mergeStashed) deps.runGit(["stash", "pop"]);

		if (!result.ok) {
			const protectionHint =
				result.stderr.includes("protected") || result.stderr.includes("permission")
					? `\n\n  If the branch is protected, use --pr to create a pull request.`
					: "";
			return {
				success: false,
				integratedLocally: false,
				commitCount: "0",
				message: "",
				error:
					`Merge failed, there may be conflicts.\n` +
					`${result.stderr}\n\n` +
					`Resolve conflicts manually, or try:\n` +
					`  taskplane integrate --pr       Create a pull request instead` +
					protectionHint,
			};
		}

		return performCleanup(deps, orchBranch, {
			success: true,
			integratedLocally: true,
			commitCount: "?",
			message: `Merged ${orchBranch} into ${currentBranch} (merge commit created).`,
		});
	}

	const pushResult = deps.runGit(["push", "origin", orchBranch]);
	if (!pushResult.ok) {
		return {
			success: false,
			integratedLocally: false,
			commitCount: "0",
			message: "",
			error: `Failed to push ${orchBranch} to origin.\n${pushResult.stderr}\n\nCheck your remote configuration and try again.`,
		};
	}

	const prTitle = batchId ? `Integrate orch batch ${batchId}` : `Integrate ${orchBranch}`;
	const ghResult = deps.runCommand("gh", [
		"pr",
		"create",
		"--base",
		currentBranch,
		"--head",
		orchBranch,
		"--title",
		prTitle,
		"--fill",
	]);
	if (!ghResult.ok) {
		return {
			success: false,
			integratedLocally: false,
			commitCount: "0",
			message: "",
			error: `Branch pushed but PR creation failed.\n${ghResult.stderr}\n\nThe branch ${orchBranch} is on origin, create the PR manually.`,
		};
	}

	const prUrl = ghResult.stdout.trim();
	return {
		success: true,
		integratedLocally: false,
		commitCount: "0",
		message:
			`Pull request created for ${orchBranch} -> ${currentBranch}.\n` +
			(prUrl ? `   ${prUrl}\n` : "") +
			`\nThe orch branch has been kept because it is needed for the PR.`,
	};
}

function performCleanup(
	deps: IntegrationExecDeps,
	orchBranch: string,
	result: IntegrationResult,
): IntegrationResult {
	const warnings: string[] = [];

	const branchDelete = deps.runGit(["branch", "-D", orchBranch]);
	if (!branchDelete.ok) warnings.push(`Could not delete local branch ${orchBranch}: ${branchDelete.stderr}`);

	try {
		deps.deleteBatchState();
	} catch (err: unknown) {
		warnings.push(`Could not clean up batch state: ${(err as Error).message}`);
	}

	if (warnings.length > 0) result.message += `\n${warnings.join("\n")}`;
	return result;
}

export function dropBatchAutostash(repoRoot: string, batchId: string): void {
	if (!batchId) return;

	const stashList = runGit(["stash", "list", "--format=%gd %s"], repoRoot);
	if (!stashList.ok || !stashList.stdout.trim()) return;

	const lines = stashList.stdout.trim().split("\n");
	const indicesToDrop: number[] = [];
	const integrateSubstring = `orch-integrate-autostash-${batchId}`;
	const mergePattern = new RegExp(`merge-agent-autostash-w\\d+-${escapeRegexStr(batchId)}`);

	for (const line of lines) {
		const match = line.match(/^stash@\{(\d+)\}\s+(.*)$/);
		if (!match) continue;
		const idx = Number.parseInt(match[1], 10);
		const subject = match[2];
		if (subject.includes(integrateSubstring) || mergePattern.test(subject)) indicesToDrop.push(idx);
	}

	indicesToDrop.sort((a, b) => b - a);
	for (const idx of indicesToDrop) runGit(["stash", "drop", `stash@{${idx}}`], repoRoot);
}

function escapeRegexStr(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildIntegrationExecutor(
	repoRoot: string,
	opId?: string,
	stateRoot?: string,
): IntegrationExecutor {
	return (mode, context) => {
		const currentBranch = getCurrentBranch(repoRoot);
		if (currentBranch && currentBranch !== context.baseBranch) {
			const checkoutResult = runGit(["checkout", context.baseBranch], repoRoot);
			if (!checkoutResult.ok) {
				return {
					success: false,
					integratedLocally: false,
					commitCount: "0",
					message: "",
					error: `Failed to switch to base branch ${context.baseBranch}: ${checkoutResult.stderr}`,
				};
			}
		}

		const deps: IntegrationExecDeps = {
			runGit: (gitArgs: string[]) => runGit(gitArgs, repoRoot),
			runCommand: (cmd: string, cmdArgs: string[]) => {
				try {
					const stdout = execFileSync(cmd, cmdArgs, {
						encoding: "utf-8",
						timeout: 60_000,
						cwd: repoRoot,
						stdio: ["pipe", "pipe", "pipe"],
					}).trim();
					return { ok: true, stdout, stderr: "" };
				} catch (err: unknown) {
					const e = err as { stdout?: string; stderr?: string; message?: string };
					return {
						ok: false,
						stdout: (e.stdout ?? "").toString().trim(),
						stderr: (e.stderr ?? e.message ?? "unknown error").toString().trim(),
					};
				}
			},
			deleteBatchState: () => {
				try {
					deleteBatchState(stateRoot ?? repoRoot);
				} catch {
					// Best effort.
				}
			},
		};

		const effectiveStateRoot = stateRoot ?? repoRoot;
		const result = withPreservedBatchHistory(effectiveStateRoot, () =>
			executeIntegration(
				mode as IntegrateMode,
				{
					...context,
					currentBranch: context.baseBranch,
				},
				deps,
			),
		);

		if (result.success && result.integratedLocally && context.batchId && opId) {
			try {
				deleteStaleBranches(repoRoot, opId, context.batchId);
				dropBatchAutostash(repoRoot, context.batchId);
			} catch {
				// Best effort.
			}

			try {
				cleanupPostIntegrate(stateRoot ?? repoRoot, context.batchId);
			} catch {
				// Best effort.
			}

			try {
				updateBatchHistoryIntegration(stateRoot ?? repoRoot, context.batchId, Date.now());
			} catch {
				// Best effort.
			}
		}

		return result;
	};
}

export function buildCiDeps(repoRoot: string, stateRoot?: string): CiDeps {
	return {
		runCommand: (cmd: string, cmdArgs: string[]) => {
			try {
				const stdout = execFileSync(cmd, cmdArgs, {
					encoding: "utf-8",
					timeout: 60_000,
					cwd: repoRoot,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				return { ok: true, stdout, stderr: "" };
			} catch (err: unknown) {
				const e = err as { stdout?: string; stderr?: string; message?: string };
				return {
					ok: false,
					stdout: (e.stdout ?? "").toString().trim(),
					stderr: (e.stderr ?? e.message ?? "unknown error").toString().trim(),
				};
			}
		},
		runGit: (gitArgs: string[]) => runGit(gitArgs, repoRoot),
		deleteBatchState: () => {
			try {
				deleteBatchState(stateRoot ?? repoRoot);
			} catch {
				// Best effort.
			}
		},
	};
}
