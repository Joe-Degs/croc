/**
 * CLI command surface regression checks — TP-128
 *
 * Verifies removed TMUX installer command is no longer exposed.
 */

import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const CLI_PATH = resolve(PROJECT_ROOT, "bin", "taskplane.mjs");

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout?.toString?.() ?? "",
			stderr: err.stderr?.toString?.() ?? "",
			exitCode: err.status ?? 1,
		};
	}
}

describe("CLI command surface", () => {
	it("does not advertise install-tmux in help output", () => {
		const result = runCli(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("install-tmux");
	});

	it("advertises config command in help output", () => {
		const result = runCli(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("config");
		expect(result.stdout).toContain("--save-as-defaults");
	});

	it("rejects install-tmux as an unknown command", () => {
		const result = runCli(["install-tmux"]);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown command: install-tmux");
	});

	it("runs correctly when invoked via symlink path", (t) => {
		const tempDir = mkdtempSync(join(tmpdir(), "taskplane-cli-link-"));
		const linkPath = join(tempDir, "taskplane-link.mjs");

		try {
			symlinkSync(CLI_PATH, linkPath, "file");
		} catch (err: any) {
			if (err?.code === "EPERM" || err?.code === "EACCES") {
				t.skip(`Symlink creation not permitted in this environment (${err.code})`);
				return;
			}
			throw err;
		}

		try {
			const stdout = execFileSync("node", [linkPath, "help"], {
				cwd: PROJECT_ROOT,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(stdout).toContain("taskplane");
			expect(stdout).toContain("Usage:");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
