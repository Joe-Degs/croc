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

	it("fails before writing runtime files when a Headroom route conflicts with a Croc-local provider", () => {
		const config = createDefaultConfig(tempDir);
		config.pi.models.providers = {
			hubtel: {
				baseUrl: "https://llm.hubtel.example.invalid/v1",
				api: "openai-responses",
			},
		};
		config.batteries.headroom.enabled = true;
		config.batteries.headroom.proxy.mode = "external";
		config.batteries.headroom.proxy.url = "http://127.0.0.1:18787";
		config.batteries.headroom.routing.providers = {
			hubtel: { target: "openai" },
		};

		assert.throws(
			() => applyConfig(tempDir, config, join(tempDir, "croc.yaml")),
			/Croc owns the Headroom route for provider "hubtel".*conflicts with the derived Headroom URL/,
		);
		assert.equal(existsSync(join(tempDir, ".pi", "settings.json")), false);
		assert.equal(existsSync(join(tempDir, ".pi", "taskplane-config.json")), false);
		assert.equal(existsSync(join(tempDir, ".croc", "headroom")), false);
	});

	it("fails before writing runtime files for unsupported Headroom routed targets", () => {
		const config = createDefaultConfig(tempDir);
		config.batteries.headroom.enabled = true;
		config.batteries.headroom.proxy.mode = "external";
		config.batteries.headroom.proxy.url = "http://127.0.0.1:18787";
		config.batteries.headroom.routing.providers = {
			gemini: { target: "gemini" },
		};

		assert.throws(
			() => applyConfig(tempDir, config, join(tempDir, "croc.yaml")),
			/Headroom target "gemini" is not supported in v1/,
		);
		assert.equal(existsSync(join(tempDir, ".pi", "settings.json")), false);
		assert.equal(existsSync(join(tempDir, ".pi", "taskplane-config.json")), false);
		assert.equal(existsSync(join(tempDir, ".croc", "headroom")), false);
	});

	it("does not touch Headroom runtime state during apply", () => {
		const config = createDefaultConfig(tempDir);
		config.batteries.headroom.enabled = true;
		config.batteries.headroom.proxy.mode = "managed";
		config.batteries.headroom.proxy.url = "http://127.0.0.1:18787";
		config.batteries.headroom.proxy.targets = {
			openai: { upstreamUrl: "https://api.openai.test/v1?token=secret" },
		};
		config.batteries.headroom.routing.providers = {
			main: { target: "openai" },
		};

		applyConfig(tempDir, config, join(tempDir, "croc.yaml"));

		assert.equal(existsSync(join(tempDir, ".croc", "headroom")), false);
	});
});
