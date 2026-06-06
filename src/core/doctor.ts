import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CrocConfig } from "./config.ts";
import { getAgentDir } from "./config.ts";
import { getBundledTaskplaneBinPath, getBundledTaskplanePackagePath } from "./paths.ts";
import { commandExists, commandOutput, spawnProcessSync } from "./process.ts";
import { collectSkillReferences, validateSkillsConfig } from "./skills.ts";
import { validateWorkBundleConfig } from "./work-bundles.ts";
import { type RuntimeContext, resolveRuntimeContext, type WorkspaceRepoSpec } from "./workspace.ts";

export interface DoctorCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	message: string;
}

function versionMessage(command: string, args: string[]): string | undefined {
	if (!commandExists(command)) return undefined;
	const result = commandOutput(command, args);
	return (result.stdout || result.stderr).trim().split("\n")[0];
}

function runGit(cwd: string, args: string[]): { ok: boolean; output: string } {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { ok: result.status === 0, output: (result.stdout || result.stderr).trim() };
}

function gitBaselineCheck(cwd: string, name = "git baseline"): DoctorCheck {
	if (!commandExists("git")) {
		return { name, status: "fail", message: "git was not found on PATH" };
	}
	const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok || inside.output !== "true") {
		return { name, status: "fail", message: "Taskplane needs a git repository" };
	}
	const head = runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	if (!head.ok) {
		return {
			name,
			status: "fail",
			message: "git repo has no commits; create an initial commit before /orch",
		};
	}
	const branch = runGit(cwd, ["branch", "--show-current"]);
	return { name, status: "ok", message: branch.output || head.output.slice(0, 12) };
}

function workspaceRepoCheck(repo: WorkspaceRepoSpec): DoctorCheck {
	if (!existsSync(repo.absolutePath)) {
		return {
			name: `repo ${repo.id}`,
			status: repo.mode === "attach" ? "fail" : "warn",
			message:
				repo.mode === "attach"
					? `missing attached repo ${repo.absolutePath}`
					: `will be prepared at ${repo.absolutePath}`,
		};
	}
	return gitBaselineCheck(repo.absolutePath, `repo ${repo.id}`);
}

function getRuntimeContext(cwd: string, config: CrocConfig): { context: RuntimeContext; checks: DoctorCheck[] } {
	try {
		return { context: resolveRuntimeContext(cwd, config), checks: [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			context: { sourceRoot: cwd, root: cwd, config },
			checks: [{ name: "workspace", status: "fail", message }],
		};
	}
}

export function runDoctor(cwd: string, config: CrocConfig, configPath: string): DoctorCheck[] {
	const runtime = getRuntimeContext(cwd, config);
	const runtimeRoot = runtime.context.root;
	const runtimeConfig = runtime.context.config;
	const checks: DoctorCheck[] = [];
	checks.push(...runtime.checks);
	const nodeVersion = versionMessage("node", ["--version"]);
	checks.push({
		name: "node",
		status: nodeVersion ? "ok" : "fail",
		message: nodeVersion ?? "node was not found on PATH",
	});

	const piVersion = versionMessage(runtimeConfig.pi.command, ["--version"]);
	checks.push({
		name: "pi",
		status: piVersion ? "ok" : "fail",
		message: piVersion ?? `${runtimeConfig.pi.command} was not found on PATH`,
	});

	const taskplanePackagePath = getBundledTaskplanePackagePath();
	const taskplaneBinPath = getBundledTaskplaneBinPath();
	const taskplaneVersion = existsSync(taskplaneBinPath)
		? versionMessage("node", [taskplaneBinPath, "version"])
		: undefined;
	checks.push({
		name: "taskplane",
		status: taskplaneVersion ? "ok" : "fail",
		message: taskplaneVersion
			? `${taskplaneVersion} (${taskplanePackagePath})`
			: `missing bundled Taskplane at ${taskplaneBinPath}`,
	});

	checks.push({
		name: "tmux",
		status: !runtimeConfig.runtime.tmux.enabled || commandExists("tmux") ? "ok" : "fail",
		message: runtimeConfig.runtime.tmux.enabled ? "tmux is required by this profile" : "tmux disabled",
	});

	checks.push({
		name: "pi settings",
		status: existsSync(join(runtimeRoot, ".pi", "settings.json")) ? "ok" : "warn",
		message: join(runtimeRoot, ".pi", "settings.json"),
	});

	checks.push({
		name: "taskplane config",
		status: existsSync(join(runtimeRoot, ".pi", "taskplane-config.json")) ? "ok" : "warn",
		message: join(runtimeRoot, ".pi", "taskplane-config.json"),
	});

	if (runtimeConfig.workspace.enabled && runtime.context.workspace) {
		checks.push({
			name: "workspace root",
			status: existsSync(runtimeRoot) ? "ok" : "warn",
			message: runtimeRoot,
		});
		checks.push({
			name: "workspace file",
			status: existsSync(runtime.context.workspace.configPath) ? "ok" : "warn",
			message: runtime.context.workspace.configPath,
		});
		checks.push({
			name: "tasks root",
			status: existsSync(runtime.context.workspace.tasksRoot) ? "ok" : "warn",
			message: runtime.context.workspace.tasksRoot,
		});
		for (const repo of runtime.context.workspace.repos) checks.push(workspaceRepoCheck(repo));
	} else if (runtimeConfig.taskplane.enabled) {
		checks.push(gitBaselineCheck(runtimeRoot));
	}

	checks.push({
		name: "agent dir",
		status: existsSync(getAgentDir()) ? "ok" : "warn",
		message: getAgentDir(),
	});

	if (runtimeConfig.batteries.webSearch.enabled && !runtimeConfig.batteries.webSearch.url) {
		checks.push({
			name: "web search",
			status: "fail",
			message: "webSearch is enabled but no SearXNG URL is configured",
		});
	} else {
		checks.push({
			name: "web search",
			status: runtimeConfig.batteries.webSearch.enabled ? "ok" : "warn",
			message: runtimeConfig.batteries.webSearch.enabled ? runtimeConfig.batteries.webSearch.url : "disabled",
		});
	}

	const skillReferences = collectSkillReferences(runtimeRoot, runtimeConfig, configPath);
	const skillDiagnostics = validateSkillsConfig(runtimeRoot, runtimeConfig, configPath);
	if (runtimeConfig.skills.enabled && skillDiagnostics.length === 0) {
		checks.push({
			name: "skills",
			status: "ok",
			message: `${skillReferences.references.size} skill(s), ${skillReferences.settingsPaths.length} path(s)`,
		});
	} else if (!runtimeConfig.skills.enabled) {
		checks.push({ name: "skills", status: "warn", message: "disabled" });
	}
	for (const diagnostic of skillDiagnostics) {
		checks.push({
			name: "skills",
			status: diagnostic.type === "error" ? "fail" : "warn",
			message: diagnostic.message,
		});
	}

	const skillFiles: Record<string, string> = {};
	for (const [name, reference] of skillReferences.references) skillFiles[name] = reference.filePath;
	const workDiagnostics = validateWorkBundleConfig(runtimeRoot, runtimeConfig, configPath, { skillFiles });
	if (runtimeConfig.work.enabled && workDiagnostics.length === 0) {
		checks.push({
			name: "work bundle",
			status: "ok",
			message: `${runtimeConfig.work.tasks.length} inline task(s), ${runtimeConfig.work.sources.length} source(s)`,
		});
	}
	for (const diagnostic of workDiagnostics) {
		checks.push({
			name: "work bundle",
			status: diagnostic.type === "error" ? "fail" : "warn",
			message: diagnostic.message,
		});
	}

	return checks;
}
