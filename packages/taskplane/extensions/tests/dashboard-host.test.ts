import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const taskplaneRoot = join(__dirname, "..", "..");
const serverPath = join(taskplaneRoot, "dashboard", "server.cjs");
const cliPath = join(taskplaneRoot, "bin", "taskplane.mjs");

let serverProcess: ChildProcessWithoutNullStreams | undefined;
let tempRoot: string | undefined;

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => {
				if (typeof address === "object" && address) {
					resolve(address.port);
				} else {
					reject(new Error("failed to allocate free port"));
				}
			});
		});
	});
}

function requestText(url: string): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = get(url, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => {
				resolve({ statusCode: res.statusCode ?? 0, body });
			});
		});
		req.on("error", reject);
		req.setTimeout(1_000, () => {
			req.destroy(new Error("request timed out"));
		});
	});
}

async function waitForDashboard(url: string): Promise<{ statusCode: number; body: string }> {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < 5_000) {
		try {
			return await requestText(url);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("dashboard did not start");
}

afterEach(async () => {
	if (serverProcess && !serverProcess.killed) {
		serverProcess.kill("SIGTERM");
		await new Promise((resolve) => serverProcess?.once("exit", resolve));
	}
	serverProcess = undefined;
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe("dashboard host option", () => {
	it("server help documents --host", () => {
		const result = spawnSync(process.execPath, [serverPath, "--help"], { encoding: "utf8" });

		assert.equal(result.status, 0);
		assert.match(result.stdout, /--host <address>/);
	});

	it("taskplane dashboard help documents --host", () => {
		const result = spawnSync(process.execPath, [cliPath, "help"], { encoding: "utf8" });

		assert.equal(result.status, 0);
		assert.match(result.stdout, /--host <address>/);
	});

	it("binds the dashboard server to the configured host", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "taskplane-dashboard-host-"));
		const port = await getFreePort();
		serverProcess = spawn(
			process.execPath,
			[serverPath, "--host", "127.0.0.1", "--port", String(port), "--root", tempRoot, "--no-open"],
			{
				cwd: tempRoot,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stderr = "";
		serverProcess.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const response = await waitForDashboard(`http://127.0.0.1:${port}/`);

		assert.equal(response.statusCode, 200, stderr);
		assert.match(response.body, /Taskplane|Orchestrator/);
	});

	it("keeps standalone dashboard behavior when host is omitted", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "taskplane-dashboard-no-host-"));
		const port = await getFreePort();
		serverProcess = spawn(
			process.execPath,
			[cliPath, "dashboard", "--port", String(port), "--no-open"],
			{
				cwd: tempRoot,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		serverProcess.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		serverProcess.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const response = await waitForDashboard(`http://localhost:${port}/`);

		assert.equal(response.statusCode, 200, stderr);
		assert.match(stdout, new RegExp(`http://localhost:${port}`));
	});
});
