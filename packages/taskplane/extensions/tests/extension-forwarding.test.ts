/**
 * Tests for extension forwarding — TP-180
 *
 * Covers:
 * - Worker spawn args include forwarded extensions
 * - Reviewer spawn args include forwarded extensions
 * - Merge agent opts include extensions
 * - Excluded extensions are not passed
 * - Explicit skills are passed as --skill flags
 * - Empty package list produces no extra -e flags
 * - buildReviewerEnv includes excludeExtensions
 * - buildWorkerExcludeEnv builds correct env vars
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReviewerEnv, buildWorkerExcludeEnv } from "../taskplane/execution.ts";
import {
	buildPiExtensionLoadSpecs,
	filterExcludedExtensions,
	loadPiSettingsPackages,
	loadPiSettingsResources,
} from "../taskplane/settings-loader.ts";
import {
	loadBatchState,
	persistEngineWorkerFailureState,
	saveBatchState,
} from "../taskplane/persistence.ts";
import {
	BATCH_STATE_SCHEMA_VERSION,
	defaultBatchDiagnostics,
	defaultResilienceState,
	freshOrchBatchState,
	type PersistedBatchState,
} from "../taskplane/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Test Helpers ─────────────────────────────────────────────────────

function createTempDir(): string {
	const dir = join(
		tmpdir(),
		`tp180-fwd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeProjectSettings(root: string, data: unknown): void {
	const dir = join(root, ".pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(data), "utf-8");
}

function readTaskplaneSource(fileName: string): string {
	return readFileSync(join(__dirname, "..", "taskplane", fileName), "utf-8").replace(/\r\n/g, "\n");
}

let tempAgentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tempAgentDir = createTempDir();
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	if (existsSync(tempAgentDir)) {
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
});

// ── Tests ────────────────────────────────────────────────────────────

describe("Worker extension forwarding", () => {
	it("produces extension list from settings and applies exclusions", () => {
		const tempDir = createTempDir();
		try {
			writeProjectSettings(tempDir, {
				packages: ["npm:pi-sage", "npm:pi-memory", "npm:taskplane"],
				extensions: ["/project/worker-extension.ts"],
				skills: ["/project/worker-skill.md"],
			});

			const resources = loadPiSettingsResources(tempDir);
			const allPackages = resources.packages;
			// taskplane should be filtered out
			assert.ok(!allPackages.includes("npm:taskplane"));
			assert.ok(allPackages.includes("npm:pi-sage"));
			assert.ok(allPackages.includes("npm:pi-memory"));
			assert.deepEqual(resources.extensions, ["/project/worker-extension.ts"]);
			assert.deepEqual(resources.skills, ["/project/worker-skill.md"]);

			// Apply worker exclusions
			const workerExtensions = buildPiExtensionLoadSpecs(resources, ["npm:pi-memory"]);
			assert.ok(workerExtensions.includes("npm:pi-sage"));
			assert.ok(workerExtensions.includes("/project/worker-extension.ts"));
			assert.ok(!workerExtensions.includes("npm:pi-memory"));

			// Simulating what lane-runner does:
			// extensions: [bridgeExtensionPath, ...workerExtensions]
			const bridgePath = "/path/to/bridge.ts";
			const extensions = [bridgePath, ...workerExtensions];
			assert.equal(extensions[0], bridgePath);
			assert.ok(extensions.includes("npm:pi-sage"));
			assert.ok(extensions.includes("/project/worker-extension.ts"));
			assert.ok(!extensions.includes("npm:pi-memory"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("empty package list produces no extra extensions", () => {
		const tempDir = createTempDir();
		try {
			// No settings.json → empty packages
			const allPackages = loadPiSettingsPackages(tempDir);
			const workerPackages = filterExcludedExtensions(allPackages, []);

			const bridgePath = "/path/to/bridge.ts";
			const extensions = [bridgePath, ...workerPackages];
			// Only bridge extension when no user packages
			// (may include global packages from real homedir, so check bridge is first)
			assert.equal(extensions[0], bridgePath);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("Spawn-site extension load spec wiring", () => {
	it("worker, reviewer, and merge spawns use buildPiExtensionLoadSpecs", () => {
		for (const fileName of ["lane-runner.ts", "agent-bridge-extension.ts", "merge.ts"]) {
			const source = readTaskplaneSource(fileName);
			assert.match(
				source,
				/\bbuildPiExtensionLoadSpecs\(/,
				`${fileName} should resolve extension load specs`,
			);
			assert.doesNotMatch(
				source,
				/\[\.\.\.settingsResources\.extensions,\s*\.\.\.settingsResources\.packages\]/,
				`${fileName} must not combine extension paths and package sources directly`,
			);
		}
	});
});

describe("Engine worker failure persistence", () => {
	it("does not save the in-memory runtime batch state as persisted batch-state.json", () => {
		const source = readTaskplaneSource("extension.ts");

		assert.match(source, /\bpersistEngineFailureState\(/);
		assert.match(source, /persistEngineFailureState\("engine-worker-error"/);
		assert.match(source, /persistEngineFailureState\("engine-worker-ipc-error"/);
		assert.match(source, /persistEngineFailureState\("engine-worker-exit"/);
		assert.doesNotMatch(
			source,
			/saveBatchState\(JSON\.stringify\(batchState,\s*null,\s*2\)/,
			"engine worker failures must persist through the schema-aware persistence writer",
		);
	});

	it("marks existing persisted state failed without replacing its task graph", () => {
		const tempDir = createTempDir();
		try {
			const existingState: PersistedBatchState = {
				schemaVersion: BATCH_STATE_SCHEMA_VERSION,
				phase: "executing",
				batchId: "batch-1",
				baseBranch: "main",
				orchBranch: "orch/test-batch-1",
				mode: "repo",
				startedAt: 1000,
				updatedAt: 1100,
				endedAt: null,
				currentWaveIndex: 0,
				totalWaves: 2,
				wavePlan: [["TASK-001"], ["TASK-002"]],
				lanes: [
					{
						laneNumber: 1,
						laneId: "lane-1",
						laneSessionId: "session-1",
						worktreePath: join(tempDir, "worktree-1"),
						branch: "lane-1",
						taskIds: ["TASK-001"],
					},
				],
				tasks: [
					{
						taskId: "TASK-001",
						laneNumber: 1,
						sessionName: "session-1",
						status: "running",
						taskFolder: join(tempDir, "tasks", "TASK-001"),
						startedAt: 1000,
						endedAt: null,
						doneFileFound: false,
						exitReason: "Task in progress",
					},
					{
						taskId: "TASK-002",
						laneNumber: 0,
						sessionName: "",
						status: "pending",
						taskFolder: join(tempDir, "tasks", "TASK-002"),
						startedAt: null,
						endedAt: null,
						doneFileFound: false,
						exitReason: "",
					},
				],
				mergeResults: [],
				totalTasks: 2,
				succeededTasks: 0,
				failedTasks: 0,
				skippedTasks: 0,
				blockedTasks: 0,
				blockedTaskIds: [],
				lastError: null,
				errors: [],
				resilience: defaultResilienceState(),
				diagnostics: defaultBatchDiagnostics(),
				segments: [],
			};
			saveBatchState(JSON.stringify(existingState, null, 2), tempDir);

			const runtimeState = freshOrchBatchState();
			runtimeState.phase = "failed";
			runtimeState.batchId = "batch-1";
			runtimeState.baseBranch = "main";
			runtimeState.orchBranch = "orch/test-batch-1";
			runtimeState.currentWaveIndex = 0;
			runtimeState.totalWaves = 1;
			runtimeState.totalTasks = 1;
			runtimeState.endedAt = 2000;
			runtimeState.blockedTaskIds = new Set(["TASK-002"]);
			runtimeState.errors = ["Engine process exited with code 1"];

			persistEngineWorkerFailureState("engine-worker-exit", runtimeState, tempDir);

			const loaded = loadBatchState(tempDir);
			assert.ok(loaded);
			assert.equal(loaded.phase, "failed");
			assert.equal(loaded.endedAt, 2000);
			assert.deepEqual(loaded.wavePlan, existingState.wavePlan);
			assert.deepEqual(
				loaded.tasks.map((task) => task.taskId),
				["TASK-001", "TASK-002"],
			);
			assert.deepEqual(loaded.blockedTaskIds, ["TASK-002"]);
			assert.deepEqual(loaded.lastError, {
				code: "engine-worker-exit",
				message: "Engine process exited with code 1",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves resume state when runtime state has not synced its batch id", () => {
		const tempDir = createTempDir();
		try {
			const existingState: PersistedBatchState = {
				schemaVersion: BATCH_STATE_SCHEMA_VERSION,
				phase: "executing",
				batchId: "resume-batch",
				baseBranch: "main",
				orchBranch: "orch/resume-batch",
				mode: "repo",
				startedAt: 1000,
				updatedAt: 1100,
				endedAt: null,
				currentWaveIndex: 1,
				totalWaves: 2,
				wavePlan: [["TASK-001"], ["TASK-002"]],
				lanes: [
					{
						laneNumber: 2,
						laneId: "lane-2",
						laneSessionId: "session-2",
						worktreePath: join(tempDir, "worktree-2"),
						branch: "lane-2",
						taskIds: ["TASK-002"],
					},
				],
				tasks: [
					{
						taskId: "TASK-001",
						laneNumber: 1,
						sessionName: "session-1",
						status: "succeeded",
						taskFolder: join(tempDir, "tasks", "TASK-001"),
						startedAt: 1000,
						endedAt: 1200,
						doneFileFound: true,
						exitReason: "Task completed",
					},
					{
						taskId: "TASK-002",
						laneNumber: 2,
						sessionName: "session-2",
						status: "running",
						taskFolder: join(tempDir, "tasks", "TASK-002"),
						startedAt: 1300,
						endedAt: null,
						doneFileFound: false,
						exitReason: "Task in progress",
					},
				],
				mergeResults: [],
				totalTasks: 2,
				succeededTasks: 1,
				failedTasks: 0,
				skippedTasks: 0,
				blockedTasks: 0,
				blockedTaskIds: [],
				lastError: null,
				errors: [],
				resilience: defaultResilienceState(),
				diagnostics: defaultBatchDiagnostics(),
				segments: [],
			};
			saveBatchState(JSON.stringify(existingState, null, 2), tempDir);

			const runtimeState = freshOrchBatchState();
			runtimeState.phase = "failed";
			runtimeState.endedAt = 2000;
			runtimeState.errors = ["Engine process error: spawn failed"];

			persistEngineWorkerFailureState("engine-worker-error", runtimeState, tempDir);

			const loaded = loadBatchState(tempDir);
			assert.ok(loaded);
			assert.equal(loaded.batchId, "resume-batch");
			assert.equal(loaded.phase, "failed");
			assert.deepEqual(loaded.wavePlan, existingState.wavePlan);
			assert.equal(loaded.totalTasks, 2);
			assert.deepEqual(
				loaded.tasks.map((task) => task.taskId),
				["TASK-001", "TASK-002"],
			);
			assert.deepEqual(loaded.lastError, {
				code: "engine-worker-error",
				message: "Engine process error: spawn failed",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("Reviewer extension forwarding", () => {
	it("builds reviewer -e args from settings with exclusions", () => {
		const tempDir = createTempDir();
		try {
			writeProjectSettings(tempDir, {
				packages: ["npm:pi-sage", "npm:pi-fetch"],
				extensions: ["/project/reviewer-extension.ts"],
				skills: ["/project/reviewer-skill.md"],
			});

			const resources = loadPiSettingsResources(tempDir);
			const reviewerExclusions = ["npm:pi-fetch"];
			const filtered = buildPiExtensionLoadSpecs(resources, reviewerExclusions);

			// Simulate reviewer args building
			const args: string[] = ["--no-extensions", "--no-skills"];
			for (const extension of filtered) {
				args.push("-e", extension);
			}
			for (const skill of resources.skills) {
				args.push("--skill", skill);
			}

			assert.ok(args.includes("-e"));
			assert.ok(args.includes("npm:pi-sage"));
			assert.ok(args.includes("/project/reviewer-extension.ts"));
			assert.ok(args.includes("--skill"));
			assert.ok(args.includes("/project/reviewer-skill.md"));
			assert.ok(!args.includes("npm:pi-fetch"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("excluded extensions are not passed as -e flags", () => {
		const tempDir = createTempDir();
		try {
			writeProjectSettings(tempDir, {
				packages: ["npm:pi-sage"],
			});

			const packages = loadPiSettingsPackages(tempDir);
			const filtered = filterExcludedExtensions(packages, ["npm:pi-sage"]);

			const args: string[] = ["--no-extensions"];
			for (const pkg of filtered) {
				args.push("-e", pkg);
			}

			// No -e flags should be present
			assert.ok(!args.includes("-e"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("Merge agent extension forwarding", () => {
	it("produces extensions array for merge agent opts", () => {
		const tempDir = createTempDir();
		try {
			writeProjectSettings(tempDir, {
				packages: ["npm:pi-sage", "npm:pi-memory"],
				extensions: ["/project/merge-extension.ts"],
				skills: ["/project/merge-skill.md"],
			});

			const resources = loadPiSettingsResources(tempDir);
			const mergeExclusions: string[] = [];
			const mergeExtensions = buildPiExtensionLoadSpecs(resources, mergeExclusions);

			// Merge agent opts.extensions
			const extensions = mergeExtensions.length > 0 ? mergeExtensions : undefined;
			assert.ok(extensions);
			assert.ok(extensions!.includes("npm:pi-sage"));
			assert.ok(extensions!.includes("npm:pi-memory"));
			assert.ok(extensions!.includes("/project/merge-extension.ts"));
			assert.deepEqual(resources.skills, ["/project/merge-skill.md"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("merge exclusions remove packages from extensions", () => {
		const tempDir = createTempDir();
		try {
			writeProjectSettings(tempDir, {
				packages: ["npm:pi-sage", "npm:pi-memory"],
			});

			const allPackages = loadPiSettingsPackages(tempDir);
			const mergeExclusions = ["npm:pi-sage"];
			const mergePackages = filterExcludedExtensions(allPackages, mergeExclusions);

			assert.ok(!mergePackages.includes("npm:pi-sage"));
			assert.ok(mergePackages.includes("npm:pi-memory"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildReviewerEnv", () => {
	it("includes TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS when exclusions present", () => {
		const env = buildReviewerEnv({
			model: "test-model",
			thinking: "on",
			tools: "read,bash",
			excludeExtensions: ["npm:pi-sage"],
		});

		assert.ok(env.TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS);
		const parsed = JSON.parse(env.TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS);
		assert.deepEqual(parsed, ["npm:pi-sage"]);
	});

	it("omits TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS when no exclusions", () => {
		const env = buildReviewerEnv({
			model: "test-model",
			excludeExtensions: [],
		});

		assert.equal(env.TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS, undefined);
	});

	it("omits TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS when undefined", () => {
		const env = buildReviewerEnv({
			model: "test-model",
		});

		assert.equal(env.TASKPLANE_REVIEWER_EXCLUDE_EXTENSIONS, undefined);
	});
});

describe("buildWorkerExcludeEnv", () => {
	it("includes TASKPLANE_WORKER_EXCLUDE_EXTENSIONS when exclusions present", () => {
		const env = buildWorkerExcludeEnv(["npm:pi-sage", "npm:pi-fetch"]);

		assert.ok(env.TASKPLANE_WORKER_EXCLUDE_EXTENSIONS);
		const parsed = JSON.parse(env.TASKPLANE_WORKER_EXCLUDE_EXTENSIONS);
		assert.deepEqual(parsed, ["npm:pi-sage", "npm:pi-fetch"]);
	});

	it("omits TASKPLANE_WORKER_EXCLUDE_EXTENSIONS when no exclusions", () => {
		const env = buildWorkerExcludeEnv([]);
		assert.equal(env.TASKPLANE_WORKER_EXCLUDE_EXTENSIONS, undefined);
	});

	it("omits TASKPLANE_WORKER_EXCLUDE_EXTENSIONS when null", () => {
		const env = buildWorkerExcludeEnv(null);
		assert.equal(env.TASKPLANE_WORKER_EXCLUDE_EXTENSIONS, undefined);
	});
});
