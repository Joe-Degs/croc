import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/core/config.ts";
import { buildTaskplaneConfig } from "../src/core/taskplane-config.ts";

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

describe("buildTaskplaneConfig", () => {
	it("inherits child agent models by default while pinning the supervisor model", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		const generated = buildTaskplaneConfig(config);

		assert.equal(getPath(generated, ["taskRunner", "worker", "model"]), "");
		assert.equal(getPath(generated, ["taskRunner", "reviewer", "model"]), "");
		assert.equal(getPath(generated, ["orchestrator", "merge", "model"]), "");
		assert.equal(getPath(generated, ["orchestrator", "supervisor", "model"]), "hubtel/grm-2.6-plus");
	});
});
