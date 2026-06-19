import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CrocConfig } from "./config.ts";
import { buildShellCommand, commandExists, spawnProcess, spawnProcessSync, waitForChildProcess } from "./process.ts";
import { getTaskFolderName } from "./work-bundles.ts";

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

export interface TmuxPane {
	paneId: string;
	title: string;
	currentPath: string;
}

export type TaskplaneLiveAction = "start" | "pause" | "resume" | "abort";

const ACTIVE_BATCH_PHASES = new Set(["planning", "executing", "merging", "paused", "resuming"]);
const TASK_ID_TARGET_PATTERN = /^[A-Z]+-\d+$/;

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

export function resolveOrchTarget(config: CrocConfig, target?: string): string | undefined {
	if (!target) return undefined;
	if (!TASK_ID_TARGET_PATTERN.test(target)) return target;

	const task = config.work.enabled ? config.work.tasks.find((entry) => entry.id === target) : undefined;
	if (!task) {
		throw new Error(`No work task ${target} found in Croc config. Use all, an area name, or a task PROMPT.md path.`);
	}

	return join(config.taskplane.tasksPath, getTaskFolderName(task), "PROMPT.md").replace(/\\/g, "/");
}

export function buildPiArgs(config: CrocConfig, target?: string): string[] {
	const args: string[] = [];
	if (config.pi.model) args.push("--model", config.pi.model);
	if (config.pi.thinking) args.push("--thinking", config.pi.thinking);
	if (config.pi.name) args.push("--name", config.pi.name);
	args.push(...config.pi.extraArgs);
	const orchCommand = buildOrchCommand(config, target);
	if (orchCommand) args.push(orchCommand);
	return args;
}

export function buildOrchCommand(config: CrocConfig, target?: string): string | undefined {
	const orchTarget = resolveOrchTarget(config, target);
	return orchTarget ? `/orch ${orchTarget}` : undefined;
}

export function buildTaskplaneControlCommand(action: TaskplaneLiveAction, args: string[], config: CrocConfig): string {
	if (action === "start") {
		const target = args.join(" ").trim();
		const command = buildOrchCommand(config, target || undefined);
		if (!command) throw new Error("taskplane start requires a target");
		return command;
	}
	if (action === "pause") {
		if (args.length > 0) throw new Error("taskplane pause does not accept arguments");
		return "/orch-pause";
	}
	if (action === "resume") {
		const unsupported = args.filter((arg) => arg !== "--force");
		if (unsupported.length > 0) throw new Error(`Unsupported taskplane resume argument: ${unsupported[0]}`);
		return args.includes("--force") ? "/orch-resume --force" : "/orch-resume";
	}
	const unsupported = args.filter((arg) => arg !== "--hard");
	if (unsupported.length > 0) throw new Error(`Unsupported taskplane abort argument: ${unsupported[0]}`);
	return args.includes("--hard") ? "/orch-abort --hard" : "/orch-abort";
}

function tmuxSessionExists(session: string): boolean {
	const result = spawnProcessSync("tmux", ["has-session", "-t", session], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return result.status === 0;
}

export function parseTmuxPanes(output: string): TmuxPane[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [paneId = "", title = "", currentPath = ""] = line.split("\t");
			return { paneId, title, currentPath };
		})
		.filter((pane) => pane.paneId.length > 0);
}

export function selectCrocTmuxPane(panes: TmuxPane[], piName: string, cwd: string): TmuxPane | undefined {
	const piTitlePrefix = `π - ${piName}`;
	const titleMatches = panes.filter((pane) => pane.title.startsWith(piTitlePrefix));
	if (titleMatches.length === 1) return titleMatches[0];
	if (titleMatches.length > 1) {
		const titleAndCwdMatches = titleMatches.filter((pane) => pane.currentPath === cwd);
		return titleAndCwdMatches.length === 1 ? titleAndCwdMatches[0] : undefined;
	}

	const cwdMatches = panes.filter((pane) => pane.currentPath === cwd);
	return cwdMatches.length === 1 ? cwdMatches[0] : undefined;
}

function resolveCrocTmuxPane(session: string, piName: string, cwd: string): TmuxPane {
	const result = spawnProcessSync(
		"tmux",
		["list-panes", "-s", "-t", session, "-F", "#{pane_id}\t#{pane_title}\t#{pane_current_path}"],
		{
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `Failed to list tmux panes for session ${session}`);
	}

	const pane = selectCrocTmuxPane(parseTmuxPanes(result.stdout), piName, cwd);
	if (!pane) throw new Error(`Could not find Croc Pi pane for tmux session ${session}.`);
	return pane;
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

export function dispatchSlashCommandToTmux(session: string, command: string, config: CrocConfig, cwd: string): void {
	const pane = resolveCrocTmuxPane(session, config.pi.name, cwd);
	const result = spawnProcessSync("tmux", ["send-keys", "-t", pane.paneId, command, "C-m"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `Failed to dispatch ${command} to tmux pane ${pane.paneId}`);
	}
	console.log(`Dispatched ${command} to tmux pane ${pane.paneId}`);
}

function dispatchTargetToTmux(session: string, target: string, config: CrocConfig, cwd: string): void {
	const command = buildOrchCommand(config, target);
	if (!command) return;
	dispatchSlashCommandToTmux(session, command, config, cwd);
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
			dispatchTargetToTmux(session, options.target, config, cwd);
		}
	}

	if (config.runtime.tmux.attach) {
		attachTmux(session);
	} else {
		console.log(`tmux session: ${session}`);
		console.log(`attach with: tmux attach -t ${session}`);
	}
}
