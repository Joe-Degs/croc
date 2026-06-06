import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CrocConfig, CrocWorkspaceRepoConfig } from "./config.ts";
import { writeJson } from "./config.ts";
import { commandExists, spawnProcessSync } from "./process.ts";

export interface WorkspaceRepoSpec {
	id: string;
	mode: "create" | "clone" | "attach";
	path: string;
	absolutePath: string;
	initialBranch?: string;
	initialCommit: boolean;
	generated: boolean;
}

export interface WorkspaceDetails {
	root: string;
	tasksRoot: string;
	tasksPath: string;
	defaultRepo: string;
	taskPacketRepo: string;
	strictRouting: boolean;
	repos: WorkspaceRepoSpec[];
	configPath: string;
	appendSystemPath: string;
	sessionPath: string;
}

export interface RuntimeContext {
	sourceRoot: string;
	root: string;
	config: CrocConfig;
	workspace?: WorkspaceDetails;
}

export interface PreparedWorkspaceResult {
	context: RuntimeContext;
	written: string[];
	createdRepos: string[];
}

const REPO_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_CREATED_BRANCH = "main";

function ensureDirectory(path: string): void {
	if (existsSync(path)) {
		if (!statSync(path).isDirectory()) throw new Error(`${path} exists but is not a directory.`);
		return;
	}
	mkdirSync(path, { recursive: true });
}

function runGit(cwd: string, args: string[], message: string): string {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || message);
	}
	return result.stdout.trim();
}

function tryGit(cwd: string, args: string[]): { ok: boolean; output: string } {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { ok: result.status === 0, output: (result.stdout || result.stderr).trim() };
}

function hasHead(repoPath: string): boolean {
	return tryGit(repoPath, ["rev-parse", "--verify", "HEAD"]).ok;
}

function isGitRepoRoot(repoPath: string): boolean {
	const topLevel = tryGit(repoPath, ["rev-parse", "--show-toplevel"]);
	return topLevel.ok && normalizePath(topLevel.output) === normalizePath(repoPath);
}

function normalizePath(path: string): string {
	const resolved = resolve(path);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function assertGitRepoRoot(repoPath: string, repoId: string): void {
	if (!isGitRepoRoot(repoPath)) {
		throw new Error(`workspace repo ${repoId} must be a git repository root: ${repoPath}`);
	}
}

function gitInit(repoPath: string, branch: string): void {
	runGit(repoPath, ["init"], `failed to initialize git repo at ${repoPath}`);
	runGit(repoPath, ["checkout", "-B", branch], `failed to set initial branch ${branch} at ${repoPath}`);
}

function writeSeedFile(repoPath: string, repoId: string): string {
	const readmePath = join(repoPath, "README.md");
	if (!existsSync(readmePath)) {
		writeFileSync(readmePath, `# ${repoId}\n\nCreated by Croc.\n`, "utf-8");
		return "README.md";
	}
	const keepPath = join(repoPath, ".gitkeep");
	if (!existsSync(keepPath)) writeFileSync(keepPath, "", "utf-8");
	return ".gitkeep";
}

function createInitialCommit(repoPath: string, repoId: string): void {
	if (hasHead(repoPath)) return;
	const seedFile = writeSeedFile(repoPath, repoId);
	runGit(repoPath, ["add", seedFile], `failed to stage ${seedFile} in ${repoPath}`);
	runGit(
		repoPath,
		["-c", "user.name=Croc", "-c", "user.email=croc@localhost", "commit", "-m", "initial commit"],
		`failed to create initial commit in ${repoPath}`,
	);
}

function prepareCreateRepo(repo: WorkspaceRepoSpec): void {
	ensureDirectory(repo.absolutePath);
	if (!isGitRepoRoot(repo.absolutePath)) {
		gitInit(repo.absolutePath, repo.initialBranch ?? DEFAULT_CREATED_BRANCH);
	}
	assertGitRepoRoot(repo.absolutePath, repo.id);
	if (repo.initialBranch && !hasHead(repo.absolutePath)) {
		runGit(
			repo.absolutePath,
			["checkout", "-B", repo.initialBranch],
			`failed to set initial branch ${repo.initialBranch}`,
		);
	}
	if (repo.initialCommit) createInitialCommit(repo.absolutePath, repo.id);
}

function prepareCloneRepo(repo: WorkspaceRepoSpec, config: CrocWorkspaceRepoConfig): void {
	if (existsSync(repo.absolutePath)) {
		assertGitRepoRoot(repo.absolutePath, repo.id);
		return;
	}
	if (!config.remote) throw new Error(`workspace repo ${repo.id} mode clone requires remote.`);
	mkdirSync(dirname(repo.absolutePath), { recursive: true });
	const args = ["clone"];
	if (repo.initialBranch) args.push("--branch", repo.initialBranch);
	args.push(config.remote, repo.absolutePath);
	const result = spawnProcessSync("git", args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error(result.stderr.trim() || `failed to clone ${config.remote}`);
	assertGitRepoRoot(repo.absolutePath, repo.id);
}

function prepareAttachRepo(repo: WorkspaceRepoSpec): void {
	if (!existsSync(repo.absolutePath))
		throw new Error(`workspace repo ${repo.id} path does not exist: ${repo.absolutePath}`);
	assertGitRepoRoot(repo.absolutePath, repo.id);
}

function relativeToWorkspace(workspaceRoot: string, path: string): string {
	const rel = relative(workspaceRoot, path).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function resolveWorkspaceRoot(cwd: string, config: CrocConfig): string {
	return isAbsolute(config.workspace.root) ? resolve(config.workspace.root) : resolve(cwd, config.workspace.root);
}

function resolveRepoPath(workspaceRoot: string, repoPath: string): string {
	return isAbsolute(repoPath) ? resolve(repoPath) : resolve(workspaceRoot, repoPath);
}

function initialCommitDefault(repo: CrocWorkspaceRepoConfig): boolean {
	if (repo.initialCommit !== undefined) return repo.initialCommit;
	return repo.mode === "create";
}

function toRepoSpec(workspaceRoot: string, repo: CrocWorkspaceRepoConfig, generated: boolean): WorkspaceRepoSpec {
	if (!REPO_ID_PATTERN.test(repo.id)) throw new Error(`workspace repo id contains unsupported characters: ${repo.id}`);
	if (repo.mode !== "create" && repo.mode !== "clone" && repo.mode !== "attach") {
		throw new Error(`workspace repo ${repo.id} mode must be create, clone, or attach.`);
	}
	const initialBranch = repo.initialBranch ?? (repo.mode === "create" ? DEFAULT_CREATED_BRANCH : undefined);
	return {
		id: repo.id,
		mode: repo.mode,
		path: repo.path,
		absolutePath: resolveRepoPath(workspaceRoot, repo.path),
		...(initialBranch ? { initialBranch } : {}),
		initialCommit: initialCommitDefault(repo),
		generated,
	};
}

function buildRepoSpecs(workspaceRoot: string, config: CrocConfig): WorkspaceRepoSpec[] {
	if (!Array.isArray(config.workspace.repos)) throw new Error("workspace.repos must be an array.");
	const repoConfigs = [...config.workspace.repos];
	if (!repoConfigs.some((repo) => repo.id === config.workspace.taskPacketRepo)) {
		repoConfigs.push({
			id: config.workspace.taskPacketRepo,
			mode: "create",
			path: config.workspace.taskPacketRepo,
			initialBranch: DEFAULT_CREATED_BRANCH,
			initialCommit: true,
		});
	}
	const seen = new Set<string>();
	return repoConfigs.map((repo) => {
		if (seen.has(repo.id)) throw new Error(`duplicate workspace repo id: ${repo.id}`);
		seen.add(repo.id);
		return toRepoSpec(workspaceRoot, repo, !config.workspace.repos.some((configured) => configured.id === repo.id));
	});
}

function getRepoSpec(repos: WorkspaceRepoSpec[], repoId: string): WorkspaceRepoSpec {
	const repo = repos.find((entry) => entry.id === repoId);
	if (!repo) throw new Error(`workspace repo not found: ${repoId}`);
	return repo;
}

function withWorkspaceTaskPath(config: CrocConfig, tasksPath: string): CrocConfig {
	return {
		...config,
		taskplane: {
			...config.taskplane,
			tasksPath,
		},
	};
}

export function resolveRuntimeContext(cwd: string, config: CrocConfig): RuntimeContext {
	const sourceRoot = resolve(cwd);
	if (!config.workspace.enabled) return { sourceRoot, root: sourceRoot, config };

	const workspaceRoot = resolveWorkspaceRoot(sourceRoot, config);
	const repos = buildRepoSpecs(workspaceRoot, config);
	getRepoSpec(repos, config.workspace.defaultRepo);
	const packetRepo = getRepoSpec(repos, config.workspace.taskPacketRepo);
	const tasksRoot = resolve(packetRepo.absolutePath, config.taskplane.tasksPath);
	const tasksPath = relativeToWorkspace(workspaceRoot, tasksRoot);
	const runtimeConfig = withWorkspaceTaskPath(config, tasksPath);
	return {
		sourceRoot,
		root: workspaceRoot,
		config: runtimeConfig,
		workspace: {
			root: workspaceRoot,
			tasksRoot,
			tasksPath,
			defaultRepo: config.workspace.defaultRepo,
			taskPacketRepo: config.workspace.taskPacketRepo,
			strictRouting: config.workspace.strictRouting,
			repos,
			configPath: join(workspaceRoot, ".pi", "taskplane-workspace.yaml"),
			appendSystemPath: join(workspaceRoot, ".pi", "APPEND_SYSTEM.md"),
			sessionPath: join(workspaceRoot, ".croc", "session.json"),
		},
	};
}

function prepareRepo(repo: WorkspaceRepoSpec, config: CrocConfig): void {
	const repoConfig = config.workspace.repos.find((entry) => entry.id === repo.id);
	if (repo.mode === "create") {
		prepareCreateRepo(repo);
		return;
	}
	if (repo.mode === "clone") {
		if (!repoConfig) throw new Error(`generated repo ${repo.id} cannot use clone mode.`);
		prepareCloneRepo(repo, repoConfig);
		return;
	}
	prepareAttachRepo(repo);
}

function writeWorkspaceYaml(workspace: WorkspaceDetails): void {
	const repos: Record<string, Record<string, string>> = {};
	for (const repo of workspace.repos) {
		repos[repo.id] = {
			path: relativeToWorkspace(workspace.root, repo.absolutePath),
		};
		if (repo.initialBranch) repos[repo.id].default_branch = repo.initialBranch;
	}
	const document = {
		repos,
		routing: {
			tasks_root: relativeToWorkspace(workspace.root, workspace.tasksRoot),
			default_repo: workspace.defaultRepo,
			task_packet_repo: workspace.taskPacketRepo,
			strict: workspace.strictRouting,
		},
	};
	mkdirSync(dirname(workspace.configPath), { recursive: true });
	writeFileSync(workspace.configPath, stringifyYaml(document), "utf-8");
}

function writeAppendSystem(context: RuntimeContext, configPath: string): void {
	if (!context.workspace) return;
	const repos = context.workspace.repos
		.map((repo) => `- ${repo.id}: ${relativeToWorkspace(context.root, repo.absolutePath)} (${repo.mode})`)
		.join("\n");
	const content = [
		"# Croc workspace context",
		"",
		"This Pi session was launched by Croc.",
		"",
		`- Croc profile: ${context.config.profile}`,
		`- Croc config: ${configPath}`,
		`- Workspace root: ${context.root}`,
		`- Task packets: ${context.workspace.tasksPath}`,
		`- Default repo: ${context.workspace.defaultRepo}`,
		`- Packet repo: ${context.workspace.taskPacketRepo}`,
		`- Strict routing: ${context.workspace.strictRouting ? "on" : "off"}`,
		"",
		"Editable repos:",
		repos,
		"",
		"Croc is the launcher/configurator. Do not edit Croc config or regenerate the workspace unless the user explicitly asks.",
		"Task prompts decide scaffolding and stack choices. Croc does not imply a scaffold preset.",
	].join("\n");
	mkdirSync(dirname(context.workspace.appendSystemPath), { recursive: true });
	writeFileSync(context.workspace.appendSystemPath, `${content}\n`, "utf-8");
}

function writeSession(context: RuntimeContext, configPath: string): void {
	if (!context.workspace) return;
	writeJson(context.workspace.sessionPath, {
		version: 1,
		profile: context.config.profile,
		configPath,
		sourceRoot: context.sourceRoot,
		workspace: {
			root: context.root,
			tasksRoot: context.workspace.tasksRoot,
			tasksPath: context.workspace.tasksPath,
			defaultRepo: context.workspace.defaultRepo,
			taskPacketRepo: context.workspace.taskPacketRepo,
			strictRouting: context.workspace.strictRouting,
			repos: context.workspace.repos.map((repo) => ({
				id: repo.id,
				mode: repo.mode,
				path: repo.absolutePath,
				generated: repo.generated,
				...(repo.initialBranch ? { initialBranch: repo.initialBranch } : {}),
			})),
		},
	});
}

export function prepareWorkspace(cwd: string, config: CrocConfig, configPath: string): PreparedWorkspaceResult {
	const context = resolveRuntimeContext(cwd, config);
	if (!context.workspace) return { context, written: [], createdRepos: [] };
	if (!commandExists("git")) throw new Error("workspace mode requires git on PATH.");

	ensureDirectory(context.root);
	const createdRepos: string[] = [];
	for (const repo of context.workspace.repos) {
		const existed = existsSync(repo.absolutePath);
		prepareRepo(repo, config);
		if (!existed) createdRepos.push(repo.id);
	}
	mkdirSync(context.workspace.tasksRoot, { recursive: true });
	writeWorkspaceYaml(context.workspace);
	writeAppendSystem(context, configPath);
	writeSession(context, configPath);
	return {
		context,
		createdRepos,
		written: [context.workspace.configPath, context.workspace.appendSystemPath, context.workspace.sessionPath],
	};
}
