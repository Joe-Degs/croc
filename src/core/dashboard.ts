import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CrocConfig } from "./config.ts";
import { getBundledTaskplaneBinPath } from "./paths.ts";
import { commandExists, spawnProcess } from "./process.ts";
import { buildRuntimeEnv } from "./runtime.ts";

export type DashboardStatus = "running" | "stopped" | "stale";

export interface DashboardState {
	status: DashboardStatus;
	pid?: number;
	pidFile: string;
}

function getPidFile(cwd: string, config: CrocConfig): string {
	return resolve(cwd, config.taskplane.dashboard.pidFile);
}

function readPid(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function getDashboardState(cwd: string, config: CrocConfig): DashboardState {
	const pidFile = getPidFile(cwd, config);
	const pid = readPid(pidFile);
	if (!pid) return { status: "stopped", pidFile };
	return { status: isProcessAlive(pid) ? "running" : "stale", pid, pidFile };
}

export function startDashboard(cwd: string, config: CrocConfig, configPath: string): DashboardState {
	if (!config.taskplane.dashboard.enabled) {
		throw new Error("Taskplane dashboard is disabled in croc.json.");
	}
	if (!commandExists("node")) {
		throw new Error("node was not found on PATH.");
	}
	const taskplaneBin = getBundledTaskplaneBinPath();
	if (!existsSync(taskplaneBin)) {
		throw new Error(`Bundled Taskplane CLI was not found at ${taskplaneBin}`);
	}
	const current = getDashboardState(cwd, config);
	if (current.status === "running") return current;
	if (current.status === "stale") unlinkSync(current.pidFile);

	const env = {
		...process.env,
		...buildRuntimeEnv(config, configPath),
	};
	const child = spawnProcess("node", [taskplaneBin, "dashboard", "--port", String(config.taskplane.dashboard.port)], {
		cwd,
		env,
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
	child.unref();
	mkdirSync(dirname(current.pidFile), { recursive: true });
	writeFileSync(current.pidFile, `${child.pid ?? ""}\n`, "utf-8");
	return getDashboardState(cwd, config);
}

export function stopDashboard(cwd: string, config: CrocConfig): DashboardState {
	const state = getDashboardState(cwd, config);
	if (state.pid && state.status === "running") {
		process.kill(state.pid, "SIGTERM");
	}
	if (existsSync(state.pidFile)) {
		unlinkSync(state.pidFile);
	}
	return getDashboardState(cwd, config);
}

export function getDashboardUrl(config: CrocConfig): string {
	return `http://localhost:${config.taskplane.dashboard.port}`;
}
