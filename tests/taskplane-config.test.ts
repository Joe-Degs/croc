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
	it("leaves agent models unset by default", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		const generated = buildTaskplaneConfig(config);

		assert.equal(getPath(generated, ["taskRunner", "worker", "model"]), "");
		assert.equal(getPath(generated, ["taskRunner", "worker", "thinking"]), "");
		assert.equal(getPath(generated, ["taskRunner", "reviewer", "model"]), "");
		assert.equal(getPath(generated, ["taskRunner", "reviewer", "thinking"]), "");
		assert.equal(getPath(generated, ["orchestrator", "merge", "model"]), "");
		assert.equal(getPath(generated, ["orchestrator", "merge", "thinking"]), "");
		assert.equal(getPath(generated, ["orchestrator", "supervisor", "model"]), "");
	});

	it("uses the default compaction kill policy", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		const generated = buildTaskplaneConfig(config);

		assert.equal(getPath(generated, ["taskRunner", "context", "compactionKillPolicy"]), "immediate");
	});

	it("passes configured compaction kill policy to Taskplane", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		config.taskplane.compactionKillPolicy = "defer";

		const generated = buildTaskplaneConfig(config);

		assert.equal(getPath(generated, ["taskRunner", "context", "compactionKillPolicy"]), "defer");
	});

	it("adds headroom_retrieve when Headroom CCR bridge is enabled", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		config.batteries.headroom.enabled = true;
		config.batteries.headroom.proxy.mode = "external";
		config.batteries.headroom.proxy.url = "http://127.0.0.1:18787";
		config.batteries.headroom.routing.providers = {
			"routed-openai": { target: "openai" },
		};
		config.batteries.headroom.ccr.mode = "bridge";

		const generated = buildTaskplaneConfig(config);

		for (const path of [
			["taskRunner", "worker", "tools"],
			["taskRunner", "reviewer", "tools"],
			["orchestrator", "merge", "tools"],
		]) {
			const tools = String(getPath(generated, path));
			assert.ok(
				tools.split(",").includes("headroom_retrieve"),
				`${path.join(".")} should include headroom_retrieve`,
			);
		}
	});

	it("does not add headroom_retrieve when Headroom CCR bridge is disabled", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		config.batteries.headroom.enabled = true;
		config.batteries.headroom.proxy.mode = "external";
		config.batteries.headroom.proxy.url = "http://127.0.0.1:18787";
		config.batteries.headroom.routing.providers = {
			"routed-openai": { target: "openai" },
		};

		const generated = buildTaskplaneConfig(config);

		for (const path of [
			["taskRunner", "worker", "tools"],
			["taskRunner", "reviewer", "tools"],
			["orchestrator", "merge", "tools"],
		]) {
			const tools = String(getPath(generated, path));
			assert.equal(
				tools.split(",").includes("headroom_retrieve"),
				false,
				`${path.join(".")} should not include headroom_retrieve`,
			);
		}
	});

	it("adds web search tools when the web search battery is enabled", () => {
		const config = createDefaultConfig("/tmp/movie-night");
		config.batteries.webSearch.enabled = true;

		const generated = buildTaskplaneConfig(config);

		for (const path of [
			["taskRunner", "worker", "tools"],
			["taskRunner", "reviewer", "tools"],
			["orchestrator", "merge", "tools"],
		]) {
			const tools = String(getPath(generated, path)).split(",");
			assert.ok(tools.includes("web_search"), `${path.join(".")} should include web_search`);
			assert.ok(tools.includes("web_fetch"), `${path.join(".")} should include web_fetch`);
		}
	});
});
