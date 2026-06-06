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

import { buildReviewerEnv, buildWorkerExcludeEnv } from "../taskplane/execution.ts";
import {
	loadPiSettingsPackages,
	loadPiSettingsResources,
	filterExcludedExtensions,
} from "../taskplane/settings-loader.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
			const workerExtensions = filterExcludedExtensions(
				[...resources.extensions, ...allPackages],
				["npm:pi-memory"],
			);
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
			const filtered = filterExcludedExtensions(
				[...resources.extensions, ...resources.packages],
				reviewerExclusions,
			);

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
			const mergeExtensions = filterExcludedExtensions(
				[...resources.extensions, ...resources.packages],
				mergeExclusions,
			);

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
