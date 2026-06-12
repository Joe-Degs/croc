import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/core/config.ts";
import { buildOrchCommand, buildPiArgs, resolveOrchTarget, selectCrocTmuxPane } from "../src/core/runtime.ts";
import { run } from "../src/main.ts";

interface HeadroomServer {
	requests: string[];
	url: string;
	close: () => Promise<void>;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function startHeadroomServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<HeadroomServer> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		handler(request, response);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		requests,
		url: `http://127.0.0.1:${address.port}`,
		close: () => closeServer(server),
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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
			"--name",
			"croc-broadcast-demo",
			"/orch packets/taskplane-tasks/TASK-004-implement-maelstrom-broadcast-challenge-part-3b/PROMPT.md",
		]);
	});

	it("uses the resolved task prompt path for tmux dispatch commands", () => {
		assert.equal(
			buildOrchCommand(configWithTasks(), "TASK-004"),
			"/orch packets/taskplane-tasks/TASK-004-implement-maelstrom-broadcast-challenge-part-3b/PROMPT.md",
		);
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

describe("croc start headroom integration", () => {
	it("checks Headroom readiness before launching Pi", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "croc-start-"));
		const marker = join(tempDir, "order.log");
		const piCommand = join(tempDir, "pi-command.sh");
		const server = await startHeadroomServer((_request, response) => {
			writeFileSync(marker, "headroom\n", { encoding: "utf-8", flag: "a" });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		const logs: string[] = [];
		const originalLog = console.log;
		try {
			writeFileSync(piCommand, `#!/bin/sh\nprintf 'pi\\n' >> ${shellQuote(marker)}\n`, "utf-8");
			chmodSync(piCommand, 0o700);
			writeFileSync(
				join(tempDir, "croc.json"),
				`${JSON.stringify(
					{
						configVersion: 1,
						runtime: { tmux: { enabled: false } },
						pi: { command: piCommand, name: "" },
						taskplane: { dashboard: { enabled: false } },
						batteries: {
							headroom: {
								enabled: true,
								proxy: {
									mode: "external",
									url: server.url,
									startupTimeoutSeconds: 1,
								},
								routing: { providers: { main: { target: "openai" } } },
							},
						},
					},
					null,
					"\t",
				)}\n`,
				"utf-8",
			);
			console.log = (...data: unknown[]) => {
				logs.push(data.map(String).join(" "));
			};

			await run(["start", "--cwd", tempDir, "--no-tmux"]);

			assert.deepEqual(server.requests, ["/readyz"]);
			assert.deepEqual(readFileSync(marker, "utf-8").trim().split("\n"), ["headroom", "pi"]);
			assert.ok(logs.includes(`Headroom ready: ${server.url} (external)`));
			assert.equal(existsSync(join(tempDir, ".croc", "headroom")), false);
		} finally {
			console.log = originalLog;
			await server.close();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
