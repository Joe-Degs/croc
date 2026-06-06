/**
 * Tests for settings-loader.ts — TP-180
 *
 * Covers:
 * - Project package reading from .pi/settings.json
 * - Global package reading from homedir settings
 * - Merge + deduplicate behavior
 * - Taskplane package filtering
 * - Missing/malformed file handling
 * - filterExcludedExtensions()
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

import {
	loadPiSettingsPackages,
	loadPiSettingsResources,
	loadPiSettingsExtensions,
	loadPiSettingsSkills,
	filterExcludedExtensions,
} from "../taskplane/settings-loader.ts";

// ── Test Helpers ─────────────────────────────────────────────────────

function createTempDir(): string {
	const dir = join(
		tmpdir(),
		`tp180-settings-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeProjectSettings(root: string, data: unknown): void {
	const dir = join(root, ".pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(data), "utf-8");
}

function writeAgentSettings(root: string, data: unknown): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "settings.json"), JSON.stringify(data), "utf-8");
}

// ── Tests ────────────────────────────────────────────────────────────

describe("loadPiSettingsPackages", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = createTempDir();
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reads project packages from .pi/settings.json", () => {
		writeProjectSettings(tempDir, {
			packages: ["npm:pi-sage", "npm:pi-memory"],
		});
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(result.includes("npm:pi-sage"));
		assert.ok(result.includes("npm:pi-memory"));
	});

	it("returns empty array when .pi/settings.json is missing", () => {
		// tempDir has no .pi/settings.json
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(Array.isArray(result));
		// May still contain global packages from real homedir
	});

	it("handles malformed JSON gracefully", () => {
		const dir = join(tempDir, ".pi");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), "not valid json{{{", "utf-8");
		// Should not throw
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(Array.isArray(result));
	});

	it("handles missing packages key gracefully", () => {
		writeProjectSettings(tempDir, { theme: "dark" });
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(Array.isArray(result));
	});

	it("handles empty packages array", () => {
		writeProjectSettings(tempDir, { packages: [] });
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(Array.isArray(result));
	});

	it("filters out taskplane itself but not unrelated packages", () => {
		writeProjectSettings(tempDir, {
			packages: ["npm:taskplane", "npm:pi-sage", "npm:taskplane-utils", "npm:@myorg/taskplane"],
		});
		const result = loadPiSettingsPackages(tempDir);
		// Exact taskplane specifiers are filtered
		assert.ok(!result.includes("npm:taskplane"));
		assert.ok(!result.includes("npm:@myorg/taskplane"));
		// Unrelated packages containing "taskplane" substring are kept
		assert.ok(result.includes("npm:taskplane-utils"));
		assert.ok(result.includes("npm:pi-sage"));
	});

	it("deduplicates packages (project first)", () => {
		writeProjectSettings(tempDir, {
			packages: ["npm:pi-sage", "npm:pi-sage"],
		});
		const result = loadPiSettingsPackages(tempDir);
		const sageCount = result.filter((p) => p === "npm:pi-sage").length;
		assert.equal(sageCount, 1);
	});

	it("filters non-string entries from packages array", () => {
		writeProjectSettings(tempDir, {
			packages: ["npm:pi-sage", 42, null, true, "npm:pi-memory"],
		});
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(result.includes("npm:pi-sage"));
		assert.ok(result.includes("npm:pi-memory"));
		// Numeric/null/boolean values should be excluded
		assert.ok(!result.some((p) => typeof p !== "string"));
	});

	it("handles packages that is not an array", () => {
		writeProjectSettings(tempDir, {
			packages: "not-an-array",
		});
		const result = loadPiSettingsPackages(tempDir);
		assert.ok(Array.isArray(result));
	});

	it("reads package object sources from settings", () => {
		writeProjectSettings(tempDir, {
			packages: [{ source: "npm:pi-sage" }, { source: "npm:taskplane" }, { notSource: "ignored" }],
		});
		const result = loadPiSettingsPackages(tempDir);
		assert.deepEqual(result, ["npm:pi-sage"]);
	});

	it("does not expand package object extension filters as unfiltered package sources", () => {
		writeProjectSettings(tempDir, {
			packages: [
				{ source: "npm:pi-sage", extensions: ["chosen-extension"] },
				{ source: "npm:pi-memory", skills: ["chosen-skill"] },
			],
		});
		const result = loadPiSettingsPackages(tempDir);
		assert.deepEqual(result, ["npm:pi-memory"]);
	});

	it("reads project and global explicit extensions and skills", () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		assert.ok(agentDir);
		writeProjectSettings(tempDir, {
			packages: ["npm:pi-sage"],
			extensions: ["/project/extension.ts", "/shared/extension.ts"],
			skills: ["/project/skill.md", "/shared/skill.md"],
		});
		writeAgentSettings(agentDir, {
			packages: ["npm:pi-memory", "npm:pi-sage"],
			extensions: ["/global/extension.ts", "/shared/extension.ts"],
			skills: ["/global/skill.md", "/shared/skill.md"],
		});

		const result = loadPiSettingsResources(tempDir);

		assert.deepEqual(result, {
			packages: ["npm:pi-sage", "npm:pi-memory"],
			extensions: ["/project/extension.ts", "/shared/extension.ts", "/global/extension.ts"],
			skills: ["/project/skill.md", "/shared/skill.md", "/global/skill.md"],
		});
		assert.deepEqual(loadPiSettingsExtensions(tempDir), result.extensions);
		assert.deepEqual(loadPiSettingsSkills(tempDir), result.skills);
	});

	it("resolves relative project and global extension and skill paths from their settings directories", () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		assert.ok(agentDir);
		writeProjectSettings(tempDir, {
			extensions: ["extensions/project-extension.ts"],
			skills: ["skills/project-skill.md"],
		});
		writeAgentSettings(agentDir, {
			extensions: ["extensions/global-extension.ts"],
			skills: ["skills/global-skill.md"],
		});

		const result = loadPiSettingsResources(tempDir);

		assert.deepEqual(result.extensions, [
			join(tempDir, ".pi", "extensions", "project-extension.ts"),
			join(agentDir, "extensions", "global-extension.ts"),
		]);
		assert.deepEqual(result.skills, [
			join(tempDir, ".pi", "skills", "project-skill.md"),
			join(agentDir, "skills", "global-skill.md"),
		]);
	});

	it("resolves tilde extension and skill paths like Pi settings", () => {
		writeProjectSettings(tempDir, {
			extensions: ["~/pi-extension.ts"],
			skills: ["~/pi-skill.md"],
		});

		const result = loadPiSettingsResources(tempDir);

		assert.deepEqual(result.extensions, [join(homedir(), "pi-extension.ts")]);
		assert.deepEqual(result.skills, [join(homedir(), "pi-skill.md")]);
	});
});

describe("filterExcludedExtensions", () => {
	it("removes exact-match exclusions", () => {
		const packages = ["npm:pi-sage", "npm:pi-memory", "npm:pi-fetch"];
		const exclusions = ["npm:pi-memory"];
		const result = filterExcludedExtensions(packages, exclusions);
		assert.deepEqual(result, ["npm:pi-sage", "npm:pi-fetch"]);
	});

	it("returns original array when exclusions is empty", () => {
		const packages = ["npm:pi-sage", "npm:pi-memory"];
		const result = filterExcludedExtensions(packages, []);
		assert.deepEqual(result, ["npm:pi-sage", "npm:pi-memory"]);
	});

	it("returns empty array when all packages are excluded", () => {
		const packages = ["npm:pi-sage"];
		const exclusions = ["npm:pi-sage"];
		const result = filterExcludedExtensions(packages, exclusions);
		assert.deepEqual(result, []);
	});

	it("handles null/undefined exclusions gracefully", () => {
		const packages = ["npm:pi-sage"];
		// TP-195: removed stale `@ts-expect-error` markers — the function
		// signature now accepts `null \| undefined` for the exclusions arg,
		// so the directives became unused-directive errors. Runtime
		// safety is still being verified by the assertions below.
		const result1 = filterExcludedExtensions(packages, null as unknown as string[]);
		assert.deepEqual(result1, ["npm:pi-sage"]);
		const result2 = filterExcludedExtensions(packages, undefined);
		assert.deepEqual(result2, ["npm:pi-sage"]);
	});

	it("does not use partial matching", () => {
		const packages = ["npm:pi-sage", "npm:pi-sage-pro"];
		const exclusions = ["npm:pi-sage"];
		const result = filterExcludedExtensions(packages, exclusions);
		assert.deepEqual(result, ["npm:pi-sage-pro"]);
	});

	it("preserves order of non-excluded packages", () => {
		const packages = ["npm:c-ext", "npm:a-ext", "npm:b-ext"];
		const exclusions = ["npm:a-ext"];
		const result = filterExcludedExtensions(packages, exclusions);
		assert.deepEqual(result, ["npm:c-ext", "npm:b-ext"]);
	});
});
