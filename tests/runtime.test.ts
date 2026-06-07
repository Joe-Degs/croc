import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/core/config.ts";
import { buildPiArgs, resolveOrchTarget, selectCrocTmuxPane } from "../src/core/runtime.ts";

describe("tmux runtime targeting", () => {
	const workspaceRoot = "/workspace/projects/broadcast-demo/.croc/workspace";
	const piName = "croc-broadcast-demo";

	it("selects the Croc Pi pane by title instead of a shell pane", () => {
		const pane = selectCrocTmuxPane(
			[
				{
					paneId: "%21",
					title: "developer shell for croc-broadcast-demo",
					currentPath: `${workspaceRoot}/repos/app`,
				},
				{
					paneId: "%20",
					title: "π - croc-broadcast-demo - workspace",
					currentPath: workspaceRoot,
				},
			],
			piName,
			workspaceRoot,
		);

		assert.equal(pane?.paneId, "%20");
	});

	it("falls back to the unique workspace cwd when the Pi title is unavailable", () => {
		const pane = selectCrocTmuxPane(
			[
				{ paneId: "%21", title: "developer-shell.local", currentPath: `${workspaceRoot}/repos/app` },
				{ paneId: "%20", title: "workspace", currentPath: workspaceRoot },
			],
			piName,
			workspaceRoot,
		);

		assert.equal(pane?.paneId, "%20");
	});

	it("refuses to guess when multiple panes match the workspace cwd", () => {
		const pane = selectCrocTmuxPane(
			[
				{ paneId: "%20", title: "workspace", currentPath: workspaceRoot },
				{ paneId: "%21", title: "shell", currentPath: workspaceRoot },
			],
			piName,
			workspaceRoot,
		);

		assert.equal(pane, undefined);
	});
});

describe("orchestrator target resolution", () => {
	function configWithTasks() {
		const config = createDefaultConfig("/workspace/projects/broadcast-demo");
		config.taskplane.tasksPath = "packets/taskplane-tasks";
		config.work.enabled = true;
		config.work.tasks = [
			{
				id: "TASK-004",
				title: "Implement Maelstrom Broadcast challenge, part 3B",
				prompt: "Do the work.",
			},
		];
		return config;
	}

	it("maps a configured task ID to its generated PROMPT.md path", () => {
		assert.equal(
			resolveOrchTarget(configWithTasks(), "TASK-004"),
			"packets/taskplane-tasks/TASK-004-implement-maelstrom-broadcast-challenge-part-3b/PROMPT.md",
		);
	});

	it("passes the resolved task prompt path to /orch", () => {
		assert.deepEqual(buildPiArgs(configWithTasks(), "TASK-004"), [
			"--model",
			"hubtel/grm-2.6-plus",
			"--thinking",
			"high",
			"--name",
			"croc-broadcast-demo",
			"/orch packets/taskplane-tasks/TASK-004-implement-maelstrom-broadcast-challenge-part-3b/PROMPT.md",
		]);
	});

	it("leaves non-task targets unchanged", () => {
		assert.equal(resolveOrchTarget(configWithTasks(), "all"), "all");
		assert.equal(resolveOrchTarget(configWithTasks(), "default"), "default");
		assert.equal(
			resolveOrchTarget(configWithTasks(), "packets/taskplane-tasks/TASK-004/PROMPT.md"),
			"packets/taskplane-tasks/TASK-004/PROMPT.md",
		);
	});
});
