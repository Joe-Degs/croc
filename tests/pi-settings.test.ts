import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createDefaultConfig } from "../src/core/config.ts";
import { writePiSettings } from "../src/core/pi-settings.ts";

describe("writePiSettings", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "croc-pi-settings-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("replaces stale Croc-owned Taskplane packages and provider extensions", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "settings.json"),
			JSON.stringify({
				packages: [
					"/old/croc/node_modules/taskplane",
					{ source: "/old/croc/packages/taskplane" },
					"npm:taskplane-utils",
					{ source: "npm:custom-package", skills: ["custom-skill"] },
				],
				extensions: ["/old/croc/dist/extensions/provider.js", "/user/provider-extension.js"],
			}),
			"utf-8",
		);

		const config = createDefaultConfig(tempDir);
		writePiSettings(tempDir, config, "/new/croc/dist/extensions/provider.js", "/new/croc/packages/taskplane", [
			"/new/croc/skills/croc-workflow",
		]);

		const settings = JSON.parse(readFileSync(join(piDir, "settings.json"), "utf-8"));

		assert.deepEqual(settings.packages, [
			"npm:taskplane-utils",
			{ source: "npm:custom-package", skills: ["custom-skill"] },
			"/new/croc/packages/taskplane",
		]);
		assert.deepEqual(settings.extensions, ["/user/provider-extension.js", "/new/croc/dist/extensions/provider.js"]);
		assert.deepEqual(settings.skills, ["/new/croc/skills/croc-workflow"]);
	});
});
