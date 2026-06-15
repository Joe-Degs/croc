import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type CrocConfig, createDefaultConfig, type HeadroomTarget } from "../src/core/config.ts";
import { getConfiguredPiProviders, validatePiModelsConfig } from "../src/core/pi-models.ts";

describe("Pi model provider configuration", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "croc-pi-models-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves existing provider loading when Headroom is disabled", () => {
		writeFileSync(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					"file-only": {
						baseUrl: "https://file-only.example.invalid/v1",
						api: "openai-completions",
						apiKey: "$FILE_ONLY_API_KEY",
					},
					shared: {
						baseUrl: "https://file-shared.example.invalid/v1",
						api: "openai-completions",
						apiKey: "$FILE_SHARED_API_KEY",
					},
				},
			}),
			"utf-8",
		);
		const config = createDefaultConfig(tempDir);
		config.pi.models.file = "models.json";
		config.pi.models.providers = {
			shared: {
				baseUrl: "https://inline-shared.example.invalid/v1",
				api: "openai-responses",
				apiKey: "$INLINE_SHARED_API_KEY",
			},
		};
		config.batteries.headroom.routing.providers = {
			shared: { target: "openai" },
		};

		const providers = getConfiguredPiProviders(config, join(tempDir, "croc.yaml"));

		assert.deepEqual([...providers.keys()].sort(), ["file-only", "shared"]);
		assert.equal(providerRecord(providers, "file-only").baseUrl, "https://file-only.example.invalid/v1");
		assert.equal(providerRecord(providers, "shared").apiKey, "$INLINE_SHARED_API_KEY");
		assert.equal(providerRecord(providers, "shared").baseUrl, "https://inline-shared.example.invalid/v1");
	});

	it("routes a provider that only exists in global Pi config as a baseUrl-only override", () => {
		const config = createHeadroomConfig(tempDir, { openai: "openai" });

		const providers = getConfiguredPiProviders(config, join(tempDir, "croc.yaml"));

		assert.deepEqual([...providers.entries()], [["openai", { baseUrl: "http://127.0.0.1:18787/v1" }]]);
	});

	it("routes inline providers while preserving Croc-local metadata", () => {
		const config = createHeadroomConfig(tempDir, { "routed-openai": "openai" });
		config.pi.models.providers = {
			"routed-openai": {
				api: "openai-responses",
				apiKey: "$ROUTED_OPENAI_API_KEY",
				headers: { authorization: "Bearer $ROUTED_OPENAI_API_KEY" },
				authHeader: true,
				models: [{ id: "routed-chat" }],
				modelOverrides: { "routed-chat": { contextWindow: 128000 } },
			},
		};

		const provider = providerRecord(getConfiguredPiProviders(config, join(tempDir, "croc.yaml")), "routed-openai");

		assert.equal(provider.baseUrl, "http://127.0.0.1:18787/v1");
		assert.equal(provider.api, "openai-responses");
		assert.equal(provider.apiKey, "$ROUTED_OPENAI_API_KEY");
		assert.deepEqual(provider.headers, { authorization: "Bearer $ROUTED_OPENAI_API_KEY" });
		assert.equal(provider.authHeader, true);
		assert.deepEqual(provider.models, [{ id: "routed-chat" }]);
		assert.deepEqual(provider.modelOverrides, { "routed-chat": { contextWindow: 128000 } });
	});

	it("routes providers loaded from pi.models.file", () => {
		writeFileSync(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					"file-anthropic": {
						api: "anthropic-messages",
						apiKey: "$ANTHROPIC_API_KEY",
						models: [{ id: "claude-file" }],
					},
				},
			}),
			"utf-8",
		);
		const config = createHeadroomConfig(tempDir, { "file-anthropic": "anthropic" });
		config.pi.models.file = "models.json";

		const provider = providerRecord(getConfiguredPiProviders(config, join(tempDir, "croc.yaml")), "file-anthropic");

		assert.equal(provider.baseUrl, "http://127.0.0.1:18787");
		assert.equal(provider.api, "anthropic-messages");
		assert.equal(provider.apiKey, "$ANTHROPIC_API_KEY");
	});

	it("accepts explicit routed base URLs that only differ by trailing slash", () => {
		const config = createHeadroomConfig(tempDir, { "routed-openai": "openai" });
		config.pi.models.providers = {
			"routed-openai": {
				baseUrl: "http://127.0.0.1:18787/v1/",
				api: "openai-responses",
			},
		};

		const provider = providerRecord(getConfiguredPiProviders(config, join(tempDir, "croc.yaml")), "routed-openai");

		assert.equal(provider.baseUrl, "http://127.0.0.1:18787/v1");
		assert.equal(provider.api, "openai-responses");
	});

	it("rejects conflicting Croc-local routed base URLs without leaking URLs", () => {
		const config = createHeadroomConfig(tempDir, { "routed-openai": "openai" });
		config.pi.models.providers = {
			"routed-openai": {
				baseUrl: "https://token@example.invalid/v1?key=super-secret",
				api: "openai-responses",
			},
		};

		assert.throws(
			() => getConfiguredPiProviders(config, join(tempDir, "croc.yaml")),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Croc owns the Headroom route for provider "routed-openai"/);
				assert.match(error.message, /conflicts with the derived Headroom URL/);
				assert.doesNotMatch(error.message, /super-secret|token@example|example\.invalid|127\.0\.0\.1:18787/);
				return true;
			},
		);
	});

	it("catches unsupported Headroom targets during Pi model validation", () => {
		const config = createHeadroomConfig(tempDir, { gemini: "gemini" });

		assert.throws(
			() => validatePiModelsConfig(config, join(tempDir, "croc.yaml")),
			/Headroom target "gemini" is not supported in v1/,
		);
	});
});

function createHeadroomConfig(tempDir: string, routes: Record<string, HeadroomTarget>): CrocConfig {
	const config = createDefaultConfig(tempDir);
	const providers: CrocConfig["batteries"]["headroom"]["routing"]["providers"] = {};
	for (const [providerName, target] of Object.entries(routes)) providers[providerName] = { target };
	config.batteries.headroom.enabled = true;
	config.batteries.headroom.proxy.mode = "external";
	config.batteries.headroom.proxy.url = "http://127.0.0.1:18787/";
	config.batteries.headroom.routing.providers = providers;
	return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerRecord(providers: Map<string, unknown>, name: string): Record<string, unknown> {
	const provider = providers.get(name);
	assert.ok(isRecord(provider), `${name} provider should be an object`);
	return provider;
}
