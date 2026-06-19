import chalk from "chalk";
import { parseArgs, printHelp } from "./cli/args.ts";
import { isTaskplaneCommandName, shouldDelegateTaskplaneHelp } from "./cli/commands.ts";
import { applyConfig } from "./core/apply.ts";
import { APP_NAME, hasConfiguredPiModels, loadConfig, VERSION, writeDefaultConfig } from "./core/config.ts";
import { getDashboardState, getDashboardUrl, startDashboard, stopDashboard } from "./core/dashboard.ts";
import { runDoctor } from "./core/doctor.ts";
import { ensureHeadroomReady, type HeadroomEnsureResult, isHeadroomEnabled } from "./core/headroom.ts";
import { redactSecrets } from "./core/redaction.ts";
import {
	attachTmux,
	buildTaskplaneControlCommand,
	dispatchSlashCommandToTmux,
	startPi,
	type TaskplaneLiveAction,
} from "./core/runtime.ts";
import { resolveTaskplaneCliCwd, runTaskplaneCli } from "./core/taskplane-cli.ts";
import { resolveRuntimeContext } from "./core/workspace.ts";

type LoadedConfig = ReturnType<typeof loadConfig>;

type ParsedArgs = ReturnType<typeof parseArgs>;

function printDiagnostics(diagnostics: Array<{ type: "warning" | "error"; message: string }>): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : chalk.yellow;
		const label = diagnostic.type === "error" ? "Error" : "Warning";
		console.error(color(`${label}: ${diagnostic.message}`));
	}
}

function statusColor(status: "ok" | "warn" | "fail"): (value: string) => string {
	if (status === "ok") return chalk.green;
	if (status === "warn") return chalk.yellow;
	return chalk.red;
}

function printWorkResult(result: { manifestPath?: string; written: string[]; skipped: string[] }): void {
	if (!result.manifestPath) return;
	console.log(`Wrote ${result.manifestPath}`);
	if (result.written.length > 0) console.log(`Materialized ${result.written.length} work file(s)`);
	if (result.skipped.length > 0) console.log(`Skipped ${result.skipped.length} unchanged/existing work file(s)`);
}

function printSkillResult(result: { manifestPath?: string; written: string[]; skipped: string[] }): void {
	if (!result.manifestPath) return;
	console.log(`Wrote ${result.manifestPath}`);
	if (result.written.length > 0) console.log(`Materialized ${result.written.length} skill file(s)`);
	if (result.skipped.length > 0) console.log(`Skipped ${result.skipped.length} unchanged skill file(s)`);
	if ("removed" in result && Array.isArray(result.removed) && result.removed.length > 0) {
		console.log(`Removed ${result.removed.length} stale skill file(s)`);
	}
}

function printWorkspaceResult(result: { runtimeRoot: string; workspaceFiles: string[]; createdRepos: string[] }): void {
	if (result.workspaceFiles.length === 0) return;
	console.log(`Runtime root ${result.runtimeRoot}`);
	for (const path of result.workspaceFiles) console.log(`Wrote ${path}`);
	if (result.createdRepos.length > 0) console.log(`Prepared ${result.createdRepos.length} workspace repo(s)`);
}

function printHeadroomReady(result: HeadroomEnsureResult): void {
	const pid = result.pid === undefined ? "" : `, pid ${result.pid}`;
	console.log(`Headroom ready: ${result.url} (${result.mode}${pid})`);
}

function isTaskplaneLiveAction(action: string | undefined): action is TaskplaneLiveAction {
	return action === "start" || action === "pause" || action === "resume" || action === "abort";
}

function printRequestedHelp(args: ParsedArgs): void {
	const helpPath = args.helpPath ?? [];
	const [command, subcommand] = helpPath;
	if (command === "taskplane" && isTaskplaneCommandName(subcommand) && shouldDelegateTaskplaneHelp(subcommand)) {
		const result = runTaskplaneCli(args.cwd, [subcommand, "--help"]);
		if (result.stderr) console.error(result.stderr);
		if (result.stdout) console.log(result.stdout);
		return;
	}
	printHelp(helpPath);
}

async function startConfiguredPi(
	options: { cwd: string; configPath: string; target?: string; disableTmux?: boolean },
	loaded: LoadedConfig,
): Promise<void> {
	const result = applyConfig(options.cwd, loaded.config, loaded.path);
	const runtime = resolveRuntimeContext(options.cwd, loaded.config);
	if (isHeadroomEnabled(runtime.config)) {
		printHeadroomReady(await ensureHeadroomReady(result.runtimeRoot, runtime.config));
	}
	if (runtime.config.taskplane.dashboard.enabled) {
		try {
			startDashboard(result.runtimeRoot, runtime.config, loaded.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.yellow(`Warning: dashboard not started: ${message}`));
		}
	}
	await startPi(runtime.config, {
		cwd: result.runtimeRoot,
		configPath: options.configPath,
		target: options.target,
		disableTmux: options.disableTmux,
	});
}

export async function run(rawArgs: string[]): Promise<void> {
	const args = parseArgs(rawArgs);
	if (args.diagnostics.length > 0) {
		printDiagnostics(args.diagnostics);
		if (args.diagnostics.some((diagnostic) => diagnostic.type === "error")) process.exit(1);
	}
	if (args.help || args.command === "help") {
		printRequestedHelp(args);
		return;
	}

	if (args.command === "version") {
		console.log(VERSION);
		return;
	}

	if (args.command === "init") {
		const path = writeDefaultConfig(args.cwd, args.configPath, args.force);
		console.log(`Wrote ${path}`);
		return;
	}

	if (args.command === "taskplane") {
		if (isTaskplaneLiveAction(args.taskplaneAction)) {
			const loaded = loadConfig(args.cwd, args.configPath);
			const taskplaneArgs = (args.taskplaneArgs ?? []).slice(1);
			if (args.taskplaneAction === "start") {
				buildTaskplaneControlCommand(args.taskplaneAction, taskplaneArgs, loaded.config);
				await startConfiguredPi(
					{
						cwd: args.cwd,
						configPath: loaded.path,
						target: taskplaneArgs.join(" ").trim() || undefined,
						disableTmux: args.disableTmux,
					},
					loaded,
				);
				return;
			}
			const runtime = resolveRuntimeContext(args.cwd, loaded.config);
			const command = buildTaskplaneControlCommand(args.taskplaneAction, taskplaneArgs, runtime.config);
			dispatchSlashCommandToTmux(runtime.config.runtime.tmux.session, command, runtime.config, runtime.root);
			return;
		}
		const cwd = resolveTaskplaneCliCwd(args.cwd, args.configPath);
		const result = runTaskplaneCli(cwd, args.taskplaneArgs ?? [args.taskplaneAction ?? "status"]);
		if (result.stderr) console.error(result.stderr);
		if (result.stdout) console.log(result.stdout);
		return;
	}

	const loaded = loadConfig(args.cwd, args.configPath);
	const config = loaded.config;

	if (args.command === "config") {
		console.log(JSON.stringify(redactSecrets(config), null, "\t"));
		return;
	}

	if (args.command === "apply") {
		const result = applyConfig(args.cwd, config, loaded.path);
		printWorkspaceResult(result);
		console.log(`Wrote ${result.taskplaneConfigPath}`);
		console.log(`Wrote ${result.piSettingsPath}`);
		if (result.taskplanePreferencesPath) console.log(`Wrote ${result.taskplanePreferencesPath}`);
		if (hasConfiguredPiModels(config)) console.log(`Enabled provider extension ${result.providerExtensionPath}`);
		printSkillResult(result.skills);
		printWorkResult(result.work);
		return;
	}

	if (args.command === "doctor") {
		for (const check of runDoctor(args.cwd, config, loaded.path)) {
			console.log(`${statusColor(check.status)(check.status.padEnd(4))} ${check.name.padEnd(18)} ${check.message}`);
		}
		return;
	}

	if (args.command === "attach") {
		attachTmux(config.runtime.tmux.session);
		return;
	}

	if (args.command === "dashboard") {
		const runtime = resolveRuntimeContext(args.cwd, config);
		const action = args.dashboardAction ?? "status";
		if (action === "start") {
			const state = startDashboard(runtime.root, runtime.config, loaded.path);
			console.log(`${state.status} ${state.pid ?? ""}`.trim());
			console.log(getDashboardUrl(runtime.config));
			return;
		}
		if (action === "stop") {
			const state = stopDashboard(runtime.root, runtime.config);
			console.log(state.status);
			return;
		}
		const state = getDashboardState(runtime.root, runtime.config);
		console.log(`${state.status} ${state.pid ?? ""}`.trim());
		console.log(getDashboardUrl(runtime.config));
		return;
	}

	if (args.command === "start") {
		await startConfiguredPi(
			{ cwd: args.cwd, configPath: loaded.path, target: args.target, disableTmux: args.disableTmux },
			loaded,
		);
		return;
	}

	throw new Error(`Unhandled ${APP_NAME} command`);
}

export function main(args: string[]): void {
	run(args).catch((error) => {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	});
}
