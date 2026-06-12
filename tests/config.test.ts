import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/core/config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: string[]): unknown {
	let current = root;
	for (const segment of path) {
		assert.ok(isRecord(current), `${segment} parent must be an object`);
		current = current[segment];
	}
	return current;
}

function getObject(root: unknown, path: string[]): Record<string, unknown> {
	const value = getPath(root, path);
	assert.ok(isRecord(value), `${path.join(".")} must be an object`);
	return value;
}

function readSchema(): unknown {
	return JSON.parse(readFileSync(new URL("../schemas/croc.schema.json", import.meta.url), "utf-8"));
}

function assertAdditionalPropertiesFalse(root: unknown, path: string[]): void {
	assert.equal(getPath(root, [...path, "additionalProperties"]), false);
}

describe("createDefaultConfig", () => {
	it("sets disabled headroom defaults", () => {
		const config = createDefaultConfig("/tmp/headroom-demo");

		assert.deepEqual(config.batteries.headroom, {
			enabled: false,
			proxy: {
				mode: "managed",
				command: "headroom",
				url: "",
				telemetry: "off",
				requireReady: true,
				startupTimeoutSeconds: 120,
				targets: {},
			},
			routing: {
				providers: {},
			},
			ccr: {
				mode: "disabled",
				timeoutSeconds: 10,
				maxResultBytes: 65536,
				trustedOrigins: [],
			},
		});
	});
});

describe("croc schema", () => {
	const headroomPath = ["$defs", "batteries", "properties", "headroom"];
	const targetNames = ["openai", "anthropic", "gemini", "cloudcode"];

	it("documents the headroom config shape", () => {
		const schema = readSchema();

		assert.equal(getPath(schema, [...headroomPath, "properties", "enabled", "type"]), "boolean");
		assert.deepEqual(getPath(schema, [...headroomPath, "properties", "proxy", "properties", "mode", "enum"]), [
			"managed",
			"external",
		]);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "proxy", "properties", "command", "type"]),
			"string",
		);
		assert.equal(getPath(schema, [...headroomPath, "properties", "proxy", "properties", "command", "minLength"]), 1);
		assert.equal(getPath(schema, [...headroomPath, "properties", "proxy", "properties", "url", "type"]), "string");
		assert.deepEqual(getPath(schema, [...headroomPath, "properties", "proxy", "properties", "telemetry", "enum"]), [
			"off",
			"on",
		]);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "proxy", "properties", "requireReady", "type"]),
			"boolean",
		);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "proxy", "properties", "startupTimeoutSeconds", "type"]),
			"number",
		);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "proxy", "properties", "startupTimeoutSeconds", "minimum"]),
			1,
		);

		const targetProperties = getObject(schema, [
			...headroomPath,
			"properties",
			"proxy",
			"properties",
			"targets",
			"properties",
		]);
		assert.deepEqual(Object.keys(targetProperties), targetNames);
		for (const target of targetNames) {
			const targetSchema = getObject(targetProperties, [target]);
			assert.deepEqual(targetSchema.required, ["upstreamUrl"]);
			assert.equal(getPath(targetSchema, ["properties", "upstreamUrl", "type"]), "string");
		}

		const providerRoute = getObject(schema, [
			...headroomPath,
			"properties",
			"routing",
			"properties",
			"providers",
			"additionalProperties",
		]);
		assert.deepEqual(providerRoute.required, ["target"]);
		assert.deepEqual(getPath(providerRoute, ["properties", "target", "enum"]), targetNames);

		assert.deepEqual(getPath(schema, [...headroomPath, "properties", "ccr", "properties", "mode", "enum"]), [
			"disabled",
			"bridge",
		]);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "ccr", "properties", "timeoutSeconds", "minimum"]),
			1,
		);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "ccr", "properties", "maxResultBytes", "minimum"]),
			1,
		);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "ccr", "properties", "trustedOrigins", "type"]),
			"array",
		);
		assert.equal(
			getPath(schema, [...headroomPath, "properties", "ccr", "properties", "trustedOrigins", "items", "type"]),
			"string",
		);
	});

	it("disallows arbitrary headroom object keys", () => {
		const schema = readSchema();
		const targetsPath = [...headroomPath, "properties", "proxy", "properties", "targets"];

		assertAdditionalPropertiesFalse(schema, headroomPath);
		assertAdditionalPropertiesFalse(schema, [...headroomPath, "properties", "proxy"]);
		assertAdditionalPropertiesFalse(schema, targetsPath);
		for (const target of targetNames) {
			assertAdditionalPropertiesFalse(schema, [...targetsPath, "properties", target]);
		}
		assertAdditionalPropertiesFalse(schema, [...headroomPath, "properties", "routing"]);
		assertAdditionalPropertiesFalse(schema, [
			...headroomPath,
			"properties",
			"routing",
			"properties",
			"providers",
			"additionalProperties",
		]);
		assertAdditionalPropertiesFalse(schema, [...headroomPath, "properties", "ccr"]);
	});
});
