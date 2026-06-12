import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli/args.ts";
import { resolveTaskplaneCliCwd } from "../src/core/taskplane-cli.ts";

describe("taskplane CLI facade", () => {
	it("falls back to the current directory when no Croc config exists", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "croc-taskplane-native-"));

		assert.equal(resolveTaskplaneCliCwd(projectRoot), projectRoot);
	});

	it("uses Croc config to resolve the runtime workspace", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "croc-taskplane-runtime-"));
		mkdirSync(join(projectRoot, ".croc", "workspace"), { recursive: true });
		writeFileSync(
			join(projectRoot, "croc.yaml"),
			[
				"configVersion: 1",
				"workspace:",
				"  enabled: true",
				"  root: .croc/workspace",
				"  defaultRepo: app",
				"  taskPacketRepo: packets",
				"  repos:",
				"    - id: app",
				"      mode: attach",
				"      path: repos/app",
			].join("\n"),
			"utf-8",
		);

		assert.equal(resolveTaskplaneCliCwd(projectRoot), join(projectRoot, ".croc", "workspace"));
	});

	it("passes taskplane integrate flags through after the action", () => {
		const args = parseArgs(["taskplane", "integrate", "--pr"]);

		assert.deepEqual(args.diagnostics, []);
		assert.deepEqual(args.taskplaneArgs, ["integrate", "--pr"]);
	});

	it("keeps Croc config parsing for taskplane commands", () => {
		const args = parseArgs(["taskplane", "summary", "--config", "custom.yaml"]);

		assert.equal(args.configPath, "custom.yaml");
		assert.deepEqual(args.taskplaneArgs, ["summary"]);
	});
});
