import chalk from "chalk";
import { parseArgs, printHelp } from "./cli/args.ts";
import { applyConfig } from "./core/apply.ts";
import { APP_NAME, loadConfig, VERSION, writeDefaultConfig } from "./core/config.ts";
import { getDashboardState, getDashboardUrl, startDashboard, stopDashboard } from "./core/dashboard.ts";
import { runDoctor } from "./core/doctor.ts";
import { attachTmux, startPi } from "./core/runtime.ts";
import { resolveRuntimeContext } from "./core/workspace.ts";

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

async function run(rawArgs: string[]): Promise<void> {
	const args = parseArgs(rawArgs);
	if (args.diagnostics.length > 0) {
		printDiagnostics(args.diagnostics);
		if (args.diagnostics.some((diagnostic) => diagnostic.type === "error")) process.exit(1);
	}

	if (args.command === "help") {
		printHelp();
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

	const loaded = loadConfig(args.cwd, args.configPath);
	const config = loaded.config;

	if (args.command === "config") {
		console.log(JSON.stringify(config, null, "\t"));
		return;
	}

	if (args.command === "apply") {
		const result = applyConfig(args.cwd, config, loaded.path);
		printWorkspaceResult(result);
		console.log(`Wrote ${result.taskplaneConfigPath}`);
		console.log(`Wrote ${result.piSettingsPath}`);
		if (result.taskplanePreferencesPath) console.log(`Wrote ${result.taskplanePreferencesPath}`);
		if (config.pi.provider.enabled) console.log(`Enabled provider extension ${result.providerExtensionPath}`);
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
		const result = applyConfig(args.cwd, config, loaded.path);
		const runtime = resolveRuntimeContext(args.cwd, config);
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
			configPath: loaded.path,
			target: args.target,
			disableTmux: args.disableTmux,
		});
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
