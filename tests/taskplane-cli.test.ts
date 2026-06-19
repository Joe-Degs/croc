import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs, printHelp } from "../src/cli/args.ts";
import { resolveTaskplaneCliCwd } from "../src/core/taskplane-cli.ts";
import { run } from "../src/main.ts";

async function captureRunOutput(args: string[]): Promise<{ stdout: string; stderr: string }> {
	const logs: string[] = [];
	const errors: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	try {
		console.log = (...data: unknown[]) => {
			logs.push(data.map(String).join(" "));
		};
		console.error = (...data: unknown[]) => {
			errors.push(data.map(String).join(" "));
		};
		await run(args);
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
	return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

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

	it("passes taskplane history arguments through", () => {
		const args = parseArgs(["taskplane", "history", "--batch", "latest", "--agents"]);

		assert.deepEqual(args.diagnostics, []);
		assert.deepEqual(args.taskplaneArgs, ["history", "--batch", "latest", "--agents"]);
	});

	it("passes taskplane mailbox arguments through", () => {
		const args = parseArgs(["taskplane", "mailbox", "latest", "--pending"]);

		assert.deepEqual(args.diagnostics, []);
		assert.deepEqual(args.taskplaneArgs, ["mailbox", "latest", "--pending"]);
	});

	it("passes taskplane messaging arguments through", () => {
		const args = parseArgs(["taskplane", "tell", "agent-1", "wrap up now"]);

		assert.deepEqual(args.diagnostics, []);
		assert.deepEqual(args.taskplaneArgs, ["tell", "agent-1", "wrap up now"]);
	});

	it("passes taskplane live control arguments through", () => {
		assert.deepEqual(parseArgs(["taskplane", "start", "TASK-004"]).taskplaneArgs, ["start", "TASK-004"]);
		assert.equal(parseArgs(["taskplane", "start", "TASK-004", "--no-tmux"]).disableTmux, true);
		assert.deepEqual(parseArgs(["taskplane", "start", "TASK-004", "--no-tmux"]).taskplaneArgs, ["start", "TASK-004"]);
		assert.deepEqual(parseArgs(["taskplane", "pause"]).taskplaneArgs, ["pause"]);
		assert.deepEqual(parseArgs(["taskplane", "resume", "--force"]).taskplaneArgs, ["resume", "--force"]);
		assert.deepEqual(parseArgs(["taskplane", "abort", "--hard"]).taskplaneArgs, ["abort", "--hard"]);
	});

	it("parses command-specific help without treating help as command input", () => {
		assert.deepEqual(parseArgs(["start", "--help"]).helpPath, ["start"]);
		assert.deepEqual(parseArgs(["taskplane", "--help"]).helpPath, ["taskplane"]);
		assert.deepEqual(parseArgs(["taskplane", "history", "--help"]).helpPath, ["taskplane", "history"]);
		assert.deepEqual(parseArgs(["taskplane", "history", "--help"]).taskplaneArgs, ["history"]);
		assert.deepEqual(parseArgs(["taskplane", "help", "history"]).helpPath, ["taskplane", "history"]);
		assert.deepEqual(parseArgs(["taskplane", "help", "start"]).helpPath, ["taskplane", "start"]);
	});

	it("prints croc command help without loading config or running the command", async () => {
		const result = await captureRunOutput(["start", "--help"]);

		assert.equal(result.stderr, "");
		assert.match(result.stdout, /croc start - /);
		assert.match(result.stdout, /Usage:/);
		assert.match(result.stdout, /croc start \[target]/);
		assert.match(result.stdout, /Taskplane target/);
	});

	it("prints croc taskplane namespace help", async () => {
		const result = await captureRunOutput(["taskplane", "--help"]);

		assert.equal(result.stderr, "");
		assert.match(result.stdout, /croc taskplane - /);
		assert.match(result.stdout, /history/);
		assert.match(result.stdout, /mailbox/);
		assert.match(result.stdout, /pause/);
		assert.match(result.stdout, /abort/);
	});

	it("delegates croc taskplane subcommand help to bundled Taskplane", async () => {
		const result = await captureRunOutput(["taskplane", "history", "--help"]);

		assert.equal(result.stderr, "");
		assert.match(result.stdout, /taskplane history/);
		assert.match(result.stdout, /--batch <id\|latest>/);
		assert.match(result.stdout, /--agents/);
	});

	it("delegates croc taskplane help command for native Taskplane commands", async () => {
		const result = await captureRunOutput(["taskplane", "help", "history"]);

		assert.equal(result.stderr, "");
		assert.match(result.stdout, /taskplane history/);
		assert.match(result.stdout, /--batch <id\|latest>/);
	});

	it("passes taskplane inspection smoke vectors through", () => {
		assert.deepEqual(parseArgs(["taskplane", "history", "--batch", "latest", "--events"]).taskplaneArgs, [
			"history",
			"--batch",
			"latest",
			"--events",
		]);
		assert.deepEqual(parseArgs(["taskplane", "mailbox", "latest", "--agent", "agent-1"]).taskplaneArgs, [
			"mailbox",
			"latest",
			"--agent",
			"agent-1",
		]);
		assert.deepEqual(parseArgs(["taskplane", "replies", "--batch", "latest"]).taskplaneArgs, [
			"replies",
			"--batch",
			"latest",
		]);
	});

	it("keeps Croc config parsing for taskplane commands", () => {
		const args = parseArgs(["taskplane", "summary", "--config", "custom.yaml"]);

		assert.equal(args.configPath, "custom.yaml");
		assert.deepEqual(args.taskplaneArgs, ["summary"]);
	});

	it("advertises implemented taskplane commands in Croc help", () => {
		const logs: string[] = [];
		const originalLog = console.log;
		try {
			console.log = (...data: unknown[]) => {
				logs.push(data.map(String).join(" "));
			};
			printHelp();
		} finally {
			console.log = originalLog;
		}

		const output = logs.join("\n");
		assert.match(output, /history/);
		assert.match(output, /mailbox/);
		assert.match(output, /tell/);
		assert.match(output, /broadcast/);
		assert.doesNotMatch(output, /exec/);
	});

	it("keeps taskplane exec deferred in Croc parser", () => {
		const args = parseArgs(["taskplane", "exec", "hello"]);

		assert.deepEqual(args.diagnostics, [{ type: "error", message: "Unknown taskplane action: exec" }]);
		assert.deepEqual(args.taskplaneArgs, ["status"]);
	});

	it("keeps taskplane exec deferred for help variants", () => {
		assert.deepEqual(parseArgs(["taskplane", "exec", "--help"]).diagnostics, [
			{ type: "error", message: "Unknown taskplane action: exec" },
		]);
		assert.deepEqual(parseArgs(["taskplane", "help", "exec"]).diagnostics, [
			{ type: "error", message: "Unknown taskplane action: exec" },
		]);
	});
});
