import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyConfig } from "../src/core/apply.ts";
import { createDefaultConfig } from "../src/core/config.ts";

describe("applyConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "croc-apply-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("fails before writing runtime files when pi.models.file is missing", () => {
		const config = createDefaultConfig(tempDir);
		config.pi.models.file = "missing-models.json";

		assert.throws(
			() => applyConfig(tempDir, config, join(tempDir, "croc.yaml")),
			/Configured Pi models file not found: .*missing-models\.json/,
		);
		assert.equal(existsSync(join(tempDir, ".pi", "settings.json")), false);
		assert.equal(existsSync(join(tempDir, ".pi", "taskplane-config.json")), false);
	});
});
