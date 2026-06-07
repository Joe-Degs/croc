import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectCrocTmuxPane } from "../src/core/runtime.ts";

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
