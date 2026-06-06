import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/core/config.ts";
import { buildDashboardArgs, getDashboardUrl } from "../src/core/dashboard.ts";

describe("dashboard config", () => {
	it("defaults to a local-only dashboard host", () => {
		const config = createDefaultConfig("/tmp/croc-dashboard");

		assert.equal(config.taskplane.dashboard.host, "127.0.0.1");
		assert.equal(getDashboardUrl(config), "http://127.0.0.1:8099");
	});

	it("passes configured host and port to the bundled Taskplane dashboard", () => {
		const config = createDefaultConfig("/tmp/croc-dashboard");
		config.taskplane.dashboard.host = "0.0.0.0";
		config.taskplane.dashboard.port = 8777;

		const args = buildDashboardArgs(config);

		assert.deepEqual(args.slice(1), ["dashboard", "--host", "0.0.0.0", "--port", "8777"]);
		assert.equal(getDashboardUrl(config), "http://0.0.0.0:8777");
	});
});
