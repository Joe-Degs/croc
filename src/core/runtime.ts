import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CrocConfig } from "./config.ts";
import { buildShellCommand, commandExists, spawnProcess, spawnProcessSync, waitForChildProcess } from "./process.ts";

export interface RuntimeOptions {
	cwd: string;
	configPath: string;
	target?: string;
	disableTmux?: boolean;
}

export interface RuntimeEnv extends Record<string, string | undefined> {
	CROC_CONFIG: string;
	CROC_PROFILE: string;
	SEARXNG_URL?: string;
	SEARXNG_API_KEY?: string;
}

interface BatchStateSummary {
	batchId?: string;
	phase?: string;
}

const ACTIVE_BATCH_PHASES = new Set(["planning", "executing", "merging", "paused", "resuming"]);

export function buildRuntimeEnv(config: CrocConfig, configPath: string): RuntimeEnv {
	const env: RuntimeEnv = {
		CROC_CONFIG: configPath,
		CROC_PROFILE: config.profile,
	};
	if (config.batteries.webSearch.enabled && config.batteries.webSearch.url) {
		env.SEARXNG_URL = config.batteries.webSearch.url;
		const key = process.env[config.batteries.webSearch.apiKeyEnv];
		if (key) env.SEARXNG_API_KEY = key;
	}
	return env;
}

export function buildPiArgs(config: CrocConfig, target?: string): string[] {
	const args: string[] = [];
	if (config.pi.model) args.push("--model", config.pi.model);
	if (config.pi.thinking) args.push("--thinking", config.pi.thinking);
	if (config.pi.name) args.push("--name", config.pi.name);
	args.push(...config.pi.extraArgs);
	if (target) args.push(`/orch ${target}`);
	return args;
}

function tmuxSessionExists(session: string): boolean {
	const result = spawnProcessSync("tmux", ["has-session", "-t", session], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return result.status === 0;
}

function readBatchState(cwd: string): BatchStateSummary | undefined {
	const path = join(cwd, ".pi", "batch-state.json");
	if (!existsSync(path)) return undefined;

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof raw !== "object" || raw === null) return undefined;
		const record = raw as Record<string, unknown>;
		return {
			...(typeof record.batchId === "string" ? { batchId: record.batchId } : {}),
			...(typeof record.phase === "string" ? { phase: record.phase } : {}),
		};
	} catch {
		return undefined;
	}
}

function hasActiveBatch(cwd: string): BatchStateSummary | undefined {
	const state = readBatchState(cwd);
	if (!state?.phase) return undefined;
	return ACTIVE_BATCH_PHASES.has(state.phase) ? state : undefined;
}

function dispatchTargetToTmux(session: string, target: string): void {
	const command = `/orch ${target}`;
	const result = spawnProcessSync("tmux", ["send-keys", "-t", session, command, "C-m"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `Failed to dispatch ${command} to tmux session ${session}`);
	}
	console.log(`Dispatched ${command} to tmux session ${session}`);
}

export function attachTmux(session: string): void {
	const child = spawnProcess("tmux", ["attach", "-t", session], { stdio: "inherit" });
	child.once("error", (error) => {
		throw error;
	});
}

export async function startPi(config: CrocConfig, options: RuntimeOptions): Promise<void> {
	const cwd = resolve(options.cwd);
	const env = { ...process.env, ...buildRuntimeEnv(config, options.configPath) };
	const piArgs = buildPiArgs(config, options.target);
	const useTmux = config.runtime.tmux.enabled && !options.disableTmux;
	if (!useTmux) {
		const child = spawnProcess(config.pi.command, piArgs, { cwd, env, stdio: "inherit" });
		const code = await waitForChildProcess(child);
		if (code && code !== 0) {
			throw new Error(`${config.pi.command} exited with code ${code}`);
		}
		return;
	}

	if (!commandExists("tmux")) {
		throw new Error("tmux is enabled but tmux was not found on PATH.");
	}

	const session = config.runtime.tmux.session;
	const sessionExists = tmuxSessionExists(session);
	if (!sessionExists) {
		const command = buildShellCommand(buildRuntimeEnv(config, options.configPath), config.pi.command, piArgs);
		const result = spawnProcessSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd, "sh", "-lc", command], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) {
			throw new Error(result.stderr.trim() || `Failed to start tmux session ${session}`);
		}
	} else if (options.target) {
		const activeBatch = hasActiveBatch(cwd);
		if (activeBatch) {
			const id = activeBatch.batchId ? ` ${activeBatch.batchId}` : "";
			console.log(`tmux session ${session} is already running batch${id} (${activeBatch.phase}).`);
			console.log(`Not dispatching /orch ${options.target}.`);
		} else {
			dispatchTargetToTmux(session, options.target);
		}
	}

	if (config.runtime.tmux.attach) {
		attachTmux(session);
	} else {
		console.log(`tmux session: ${session}`);
		console.log(`attach with: tmux attach -t ${session}`);
	}
}
