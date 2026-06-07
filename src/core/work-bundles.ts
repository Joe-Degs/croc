import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CrocConfig, CrocContentSource, CrocWorkTaskConfig, WorkOverwrite } from "./config.ts";
import { readJsonObject, writeJson } from "./config.ts";

export interface WorkBundleResult {
	manifestPath?: string;
	written: string[];
	skipped: string[];
}

export interface WorkBundleDiagnostic {
	type: "warning" | "error";
	message: string;
}

export interface WorkBundleOptions {
	skillFiles?: Record<string, string>;
}

interface WorkManifestFile {
	sha256: string;
	source: string;
}

interface WorkManifest {
	version: 1;
	generatedAt: string;
	files: Record<string, WorkManifestFile>;
}

interface WriteState {
	cwd: string;
	overwrite: WorkOverwrite;
	previousManifest: WorkManifest;
	nextManifest: WorkManifest;
	result: WorkBundleResult;
}

interface ParsedStep {
	number: number;
	name: string;
	checkboxes: string[];
}

const TASK_ID_PATTERN = /^[A-Z]+-\d+$/;
const GENERATED_STATUS_SOURCE = "generated-status";

export function getWorkManifestPath(cwd: string): string {
	return join(cwd, ".croc", "work-manifest.json");
}

function relativePath(cwd: string, path: string): string {
	return relative(cwd, path).replace(/\\/g, "/");
}

function resolveFromConfig(configPath: string, path: string): string {
	return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function ensureTrailingNewline(content: string): string {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(path: string): WorkManifest {
	if (!existsSync(path)) return { version: 1, generatedAt: new Date().toISOString(), files: {} };
	const raw = readJsonObject(path);
	const files = isRecord(raw.files) ? raw.files : {};
	const manifestFiles: Record<string, WorkManifestFile> = {};
	for (const [filePath, entry] of Object.entries(files)) {
		if (!isRecord(entry)) continue;
		if (typeof entry.sha256 !== "string" || typeof entry.source !== "string") continue;
		manifestFiles[filePath] = { sha256: entry.sha256, source: entry.source };
	}
	return { version: 1, generatedAt: String(raw.generatedAt ?? new Date().toISOString()), files: manifestFiles };
}

function writeManifest(path: string, manifest: WorkManifest): void {
	writeJson(path, manifest);
}

function resolveContent(source: CrocContentSource | undefined, configPath: string, label: string): string | undefined {
	if (source === undefined) return undefined;
	if (typeof source === "string") return source;
	const hasInline = typeof source.inline === "string";
	const hasFile = typeof source.file === "string" && source.file.length > 0;
	if (hasInline && hasFile) throw new Error(`${label} cannot define both inline and file.`);
	if (hasInline) return source.inline;
	if (hasFile) return readFileSync(resolveFromConfig(configPath, source.file!), "utf-8");
	throw new Error(`${label} must define inline or file.`);
}

function writeManagedFile(state: WriteState, path: string, content: string | Buffer, source: string): void {
	const normalizedContent = typeof content === "string" ? ensureTrailingNewline(content) : content;
	const nextHash = sha256(normalizedContent);
	const rel = relativePath(state.cwd, path);

	if (existsSync(path)) {
		const current = readFileSync(path);
		const currentHash = sha256(current);
		if (currentHash === nextHash) {
			state.nextManifest.files[rel] = { sha256: nextHash, source };
			state.result.skipped.push(rel);
			return;
		}

		if (state.overwrite === "never") {
			throw new Error(`${rel} already exists and work.overwrite is "never".`);
		}

		if (state.overwrite === "if-generated") {
			const previous = state.previousManifest.files[rel];
			if (!previous) {
				throw new Error(`${rel} already exists and is not recorded in .croc/work-manifest.json.`);
			}
			if (previous.sha256 !== currentHash) {
				throw new Error(`${rel} was modified outside Croc; refusing to overwrite it.`);
			}
		}
	}

	mkdirSync(dirname(path), { recursive: true });
	if (typeof normalizedContent === "string") {
		writeFileSync(path, normalizedContent, "utf-8");
	} else {
		writeFileSync(path, normalizedContent);
	}
	state.nextManifest.files[rel] = { sha256: nextHash, source };
	state.result.written.push(rel);
}

function writeStatusIfMissing(state: WriteState, path: string, content: string): void {
	const rel = relativePath(state.cwd, path);
	if (existsSync(path)) {
		state.result.skipped.push(rel);
		return;
	}
	writeManagedFile(state, path, content, GENERATED_STATUS_SOURCE);
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "task"
	);
}

export function getTaskFolderName(task: CrocWorkTaskConfig): string {
	const title = typeof task.title === "string" && task.title.length > 0 ? task.title : task.id;
	const base = task.folder ? slugify(task.folder) : `${task.id}-${slugify(title)}`;
	return base.toUpperCase().startsWith(`${task.id}-`) || base.toUpperCase() === task.id ? base : `${task.id}-${base}`;
}

function getTaskSize(task: CrocWorkTaskConfig): "S" | "M" | "L" {
	return task.size ?? "M";
}

function getReviewLevel(task: CrocWorkTaskConfig): number {
	return task.reviewLevel ?? 0;
}

function getDependencies(task: CrocWorkTaskConfig): string[] {
	return Array.isArray(task.dependencies) ? task.dependencies : [];
}

function getContextDocs(task: CrocWorkTaskConfig): string[] {
	return Array.isArray(task.contextDocs) ? task.contextDocs : [];
}

function getFileScope(task: CrocWorkTaskConfig): string[] {
	return Array.isArray(task.fileScope) ? task.fileScope : [];
}

function formatDependencies(dependencies: string[]): string {
	if (dependencies.length === 0) return "- **None**";
	return dependencies.map((dependency) => `- ${dependency}`).join("\n");
}

function formatContextDocs(task: CrocWorkTaskConfig, tasksPath: string, hasContext: boolean): string {
	const contextDocs = getContextDocs(task);
	const docs = contextDocs.length > 0 ? contextDocs : hasContext ? [`${tasksPath}/CONTEXT.md`] : [];
	if (docs.length === 0) return "_No additional context needed._";
	return docs.map((doc) => `- \`${doc}\``).join("\n");
}

function formatFileScope(fileScope: string[]): string {
	if (fileScope.length === 0) return "- _No explicit file scope._";
	return fileScope.map((file) => `- \`${file}\``).join("\n");
}

function promptHasExecutionTarget(content: string): boolean {
	return /^##\s+Execution Target\s*$/m.test(content);
}

function ensureExecutionTarget(content: string, task: CrocWorkTaskConfig): string {
	if (!task.repo || promptHasExecutionTarget(content)) return content;
	return [content.trimEnd(), "", "## Execution Target", "", `Repo: ${task.repo}`].join("\n");
}

function promptHasRequiredSkills(content: string): boolean {
	return /^##\s+Required Skills\s*$/m.test(content);
}

function getRequiredSkills(task: CrocWorkTaskConfig, config: CrocConfig): string[] {
	if (!config.skills.enabled) return [];
	return [...new Set([...(config.skills.work.include ?? []), ...(task.skills ?? [])])];
}

function ensureRequiredSkills(
	content: string,
	task: CrocWorkTaskConfig,
	config: CrocConfig,
	options: WorkBundleOptions,
): string {
	if (promptHasRequiredSkills(content)) return content;
	const skills = getRequiredSkills(task, config);
	if (skills.length === 0) return content;
	const lines = skills.map((skill) => {
		const path = options.skillFiles?.[skill];
		return path ? `- \`${path}\`` : `- ${skill}`;
	});
	return [content.trimEnd(), "", "## Required Skills", "", "Read these before starting:", "", ...lines].join("\n");
}

function ensureGeneratedSections(
	content: string,
	task: CrocWorkTaskConfig,
	config: CrocConfig,
	options: WorkBundleOptions,
): string {
	return ensureExecutionTarget(ensureRequiredSkills(content, task, config, options), task);
}

function promptHasTaskHeading(content: string): boolean {
	return /^#\s+Task:/m.test(content);
}

function promptHasSteps(content: string): boolean {
	return /^###\s+Step\s+\d+:/m.test(content);
}

function ensurePromptSteps(content: string): string {
	if (promptHasSteps(content)) return content;
	return [
		content.trimEnd(),
		"",
		"## Steps",
		"",
		"### Step 0: Execute work",
		"",
		"- [ ] Read the provided context",
		"- [ ] Complete the requested work",
		"- [ ] Verify the result",
	].join("\n");
}

function buildPromptContent(
	task: CrocWorkTaskConfig,
	body: string,
	config: CrocConfig,
	hasContext: boolean,
	options: WorkBundleOptions,
): string {
	const withSteps = ensurePromptSteps(body);
	if (promptHasTaskHeading(withSteps)) return ensureGeneratedSections(withSteps, task, config, options);
	const today = new Date().toISOString().slice(0, 10);
	return ensureGeneratedSections(
		[
			`# Task: ${task.id} - ${task.title}`,
			"",
			`**Created:** ${today}`,
			`**Size:** ${getTaskSize(task)}`,
			"",
			`## Review Level: ${getReviewLevel(task)}`,
			"",
			"## Mission",
			"",
			withSteps.trim(),
			"",
			"## Dependencies",
			"",
			formatDependencies(getDependencies(task)),
			"",
			"## Context to Read First",
			"",
			formatContextDocs(task, config.taskplane.tasksPath, hasContext),
			"",
			"## Environment",
			"",
			"- **Workspace:** Project root",
			"- **Services required:** None specified",
			"",
			"## File Scope",
			"",
			formatFileScope(getFileScope(task)),
			"",
			"## Completion Criteria",
			"",
			"- [ ] Requested work is complete",
			"- [ ] Relevant checks were run or blockers are recorded in STATUS.md",
			"",
			"## Do NOT",
			"",
			"- Modify files unrelated to this task",
			"- Hide blockers or failed checks",
			"",
			"---",
			"",
			"## Amendments (added during execution)",
			"",
			"<!-- Workers add amendments here if issues are discovered during execution. -->",
		].join("\n"),
		task,
		config,
		options,
	);
}

function parsePromptTitle(content: string, task: CrocWorkTaskConfig): { id: string; title: string } {
	const match = content.match(/^#\s+Task:\s+([A-Z]+-\d+)\s*[-\u2014]\s*(.+)$/m);
	if (!match) return { id: task.id, title: task.title ?? task.id };
	return { id: match[1], title: match[2].trim() };
}

function parseSteps(content: string): ParsedStep[] {
	const positions: Array<{ number: number; name: string; start: number }> = [];
	const stepRegex = /^###\s+Step\s+(\d+):\s*(.+)$/gm;
	let match = stepRegex.exec(content);
	while (match !== null) {
		positions.push({ number: Number.parseInt(match[1], 10), name: match[2].trim(), start: match.index });
		match = stepRegex.exec(content);
	}
	return positions.map((position, index) => {
		const end = index + 1 < positions.length ? positions[index + 1].start : content.length;
		const section = content.slice(position.start, end);
		const checkboxes = [...section.matchAll(/^\s*-\s*\[[ xX]\]\s*(.+)$/gm)].map((checkbox) => checkbox[1].trim());
		return { number: position.number, name: position.name, checkboxes };
	});
}

function generateStatusContent(task: CrocWorkTaskConfig, promptContent: string): string {
	const today = new Date().toISOString().slice(0, 10);
	const title = parsePromptTitle(promptContent, task);
	const steps = parseSteps(promptContent);
	const lines = [
		`# ${title.id}: ${title.title} - Status`,
		"",
		"**Current Step:** Not Started",
		"**Status:** Ready for Execution",
		`**Last Updated:** ${today}`,
		`**Review Level:** ${getReviewLevel(task)}`,
		"**Review Counter:** 0",
		"**Iteration:** 0",
		`**Size:** ${getTaskSize(task)}`,
		"",
		"---",
		"",
	];
	for (const step of steps) {
		lines.push(`### Step ${step.number}: ${step.name}`, "**Status:** Not Started", "");
		for (const checkbox of step.checkboxes) lines.push(`- [ ] ${checkbox}`);
		lines.push("", "---", "");
	}
	lines.push(
		"## Reviews",
		"",
		"| # | Type | Step | Verdict | File |",
		"|---|------|------|---------|------|",
		"",
		"---",
		"",
		"## Discoveries",
		"",
		"| Discovery | Disposition | Location |",
		"|-----------|-------------|----------|",
		"",
		"---",
		"",
		"## Execution Log",
		"",
		"| Timestamp | Action | Outcome |",
		"|-----------|--------|---------|",
		`| ${today} | Task staged | STATUS.md generated by Croc |`,
		"",
		"---",
		"",
		"## Blockers",
		"",
		"*None*",
		"",
		"---",
		"",
		"## Notes",
		"",
		"*Reserved for execution notes*",
	);
	return lines.join("\n");
}

function walkFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...walkFiles(path));
		} else if (stat.isFile()) {
			files.push(path);
		}
	}
	return files;
}

function copyDirectorySource(state: WriteState, sourceDirectory: string, targetRoot: string): void {
	const sourceHasPrompt = existsSync(join(sourceDirectory, "PROMPT.md"));
	const destinationRoot = sourceHasPrompt ? join(targetRoot, basename(sourceDirectory)) : targetRoot;
	for (const sourcePath of walkFiles(sourceDirectory)) {
		const destinationPath = join(destinationRoot, relative(sourceDirectory, sourcePath));
		writeManagedFile(state, destinationPath, readFileSync(sourcePath), `directory:${sourceDirectory}`);
	}
}

export function validateWorkBundleConfig(
	cwd: string,
	config: CrocConfig,
	configPath: string,
	options: WorkBundleOptions = {},
): WorkBundleDiagnostic[] {
	const diagnostics: WorkBundleDiagnostic[] = [];
	if (!config.work.enabled) return diagnostics;
	if (
		config.work.overwrite !== "never" &&
		config.work.overwrite !== "if-generated" &&
		config.work.overwrite !== "always"
	) {
		diagnostics.push({ type: "error", message: "work.overwrite must be never, if-generated, or always." });
	}

	const seenTaskIds = new Set<string>();
	const seenFolders = new Set<string>();
	const workspaceRepos = Array.isArray(config.workspace.repos) ? config.workspace.repos : [];
	if (config.workspace.enabled && !Array.isArray(config.workspace.repos)) {
		diagnostics.push({ type: "error", message: "workspace.repos must be an array." });
	}
	const workspaceRepoIds = new Set(workspaceRepos.map((repo) => repo.id));
	if (config.workspace.taskPacketRepo) workspaceRepoIds.add(config.workspace.taskPacketRepo);
	const globalSkills =
		config.skills.enabled && Array.isArray(config.skills.work.include) ? config.skills.work.include : [];
	const sources = Array.isArray(config.work.sources) ? config.work.sources : [];
	if (!Array.isArray(config.work.sources)) {
		diagnostics.push({ type: "error", message: "work.sources must be an array." });
	}
	for (const [index, source] of sources.entries()) {
		if (source.mode !== "copy") {
			diagnostics.push({ type: "error", message: `work.sources[${index}].mode must be "copy".` });
		}
		if (typeof source.directory !== "string" || source.directory.length === 0) {
			diagnostics.push({ type: "error", message: `work.sources[${index}].directory is required.` });
			continue;
		}
		const path = resolveFromConfig(configPath, source.directory);
		if (!existsSync(path)) {
			diagnostics.push({ type: "error", message: `work.sources[${index}].directory does not exist: ${path}` });
		} else if (!statSync(path).isDirectory()) {
			diagnostics.push({ type: "error", message: `work.sources[${index}].directory is not a directory: ${path}` });
		}
	}

	const tasks = Array.isArray(config.work.tasks) ? config.work.tasks : [];
	if (!Array.isArray(config.work.tasks)) {
		diagnostics.push({ type: "error", message: "work.tasks must be an array." });
	}
	for (const [index, task] of tasks.entries()) {
		if (typeof task.id !== "string" || task.id.length === 0) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].id is required.` });
			continue;
		}
		if (!TASK_ID_PATTERN.test(task.id)) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].id must look like TASK-001.` });
		}
		if (typeof task.title !== "string" || task.title.length === 0) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].title is required.` });
		}
		if (task.skills !== undefined && !Array.isArray(task.skills)) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].skills must be an array.` });
		}
		const taskSkills = Array.isArray(task.skills) ? task.skills : [];
		const requiredSkills = [...new Set([...globalSkills, ...taskSkills])];
		if (requiredSkills.length > 0 && !config.skills.enabled) {
			diagnostics.push({
				type: "error",
				message: `work.tasks[${index}] references skills but skills.enabled is false.`,
			});
		}
		if (options.skillFiles) {
			for (const skill of requiredSkills) {
				if (!options.skillFiles[skill]) {
					diagnostics.push({ type: "error", message: `work.tasks[${index}] references unknown skill: ${skill}` });
				}
			}
		}
		if (task.repo !== undefined && (typeof task.repo !== "string" || task.repo.length === 0)) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].repo must be a non-empty string.` });
		} else if (config.workspace.enabled && config.workspace.strictRouting && !task.repo) {
			diagnostics.push({
				type: "error",
				message: `work.tasks[${index}].repo is required by strict workspace routing.`,
			});
		} else if (config.workspace.enabled && task.repo && !workspaceRepoIds.has(task.repo)) {
			diagnostics.push({
				type: "error",
				message: `work.tasks[${index}].repo does not match a workspace repo: ${task.repo}`,
			});
		}
		if (task.size !== undefined && task.size !== "S" && task.size !== "M" && task.size !== "L") {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].size must be S, M, or L.` });
		}
		if (task.reviewLevel !== undefined && (!Number.isInteger(task.reviewLevel) || task.reviewLevel < 0)) {
			diagnostics.push({
				type: "error",
				message: `work.tasks[${index}].reviewLevel must be a non-negative integer.`,
			});
		}
		if (task.dependencies !== undefined && !Array.isArray(task.dependencies)) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].dependencies must be an array.` });
		}
		if (task.contextDocs !== undefined && !Array.isArray(task.contextDocs)) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].contextDocs must be an array.` });
		}
		if (task.fileScope !== undefined && !Array.isArray(task.fileScope)) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].fileScope must be an array.` });
		}
		if (seenTaskIds.has(task.id)) {
			diagnostics.push({ type: "error", message: `Duplicate work task id: ${task.id}` });
		}
		seenTaskIds.add(task.id);

		if (task.folder !== undefined && (task.folder.includes("/") || task.folder.includes("\\"))) {
			diagnostics.push({ type: "error", message: `work.tasks[${index}].folder must not contain path separators.` });
		}
		const folderName = getTaskFolderName(task);
		if (seenFolders.has(folderName)) {
			diagnostics.push({ type: "error", message: `Duplicate generated task folder: ${folderName}` });
		}
		seenFolders.add(folderName);

		try {
			const prompt = resolveContent(task.prompt, configPath, `work.tasks[${index}].prompt`);
			if (prompt === undefined)
				diagnostics.push({ type: "error", message: `work.tasks[${index}].prompt is required.` });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({ type: "error", message });
		}
	}

	try {
		resolveContent(config.work.context, configPath, "work.context");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		diagnostics.push({ type: "error", message });
	}

	const tasksRoot = resolve(cwd, config.taskplane.tasksPath);
	if (!tasksRoot.startsWith(resolve(cwd))) {
		diagnostics.push({ type: "warning", message: `taskplane.tasksPath resolves outside the project: ${tasksRoot}` });
	}

	return diagnostics;
}

export function materializeWorkBundle(
	cwd: string,
	config: CrocConfig,
	configPath: string,
	options: WorkBundleOptions = {},
): WorkBundleResult {
	const result: WorkBundleResult = { written: [], skipped: [] };
	if (!config.work.enabled) return result;

	const diagnostics = validateWorkBundleConfig(cwd, config, configPath, options);
	const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) {
		throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
	}

	const manifestPath = getWorkManifestPath(cwd);
	const previousManifest = readManifest(manifestPath);
	const nextManifest: WorkManifest = {
		version: 1,
		generatedAt: new Date().toISOString(),
		files: { ...previousManifest.files },
	};
	const state: WriteState = { cwd, overwrite: config.work.overwrite, previousManifest, nextManifest, result };
	const tasksRoot = resolve(cwd, config.taskplane.tasksPath);
	mkdirSync(tasksRoot, { recursive: true });

	const contextContent = resolveContent(config.work.context, configPath, "work.context");
	if (contextContent !== undefined) {
		writeManagedFile(state, join(tasksRoot, "CONTEXT.md"), contextContent, "work.context");
	}

	for (const source of config.work.sources) {
		copyDirectorySource(state, resolveFromConfig(configPath, source.directory), tasksRoot);
	}

	for (const task of config.work.tasks) {
		const taskRoot = join(tasksRoot, getTaskFolderName(task));
		const body = resolveContent(task.prompt, configPath, `work.tasks.${task.id}.prompt`) ?? "";
		const promptContent = buildPromptContent(task, body, config, contextContent !== undefined, options);
		writeManagedFile(state, join(taskRoot, "PROMPT.md"), promptContent, `work.tasks.${task.id}.prompt`);
		writeStatusIfMissing(state, join(taskRoot, "STATUS.md"), generateStatusContent(task, promptContent));
		mkdirSync(join(taskRoot, ".reviews"), { recursive: true });
	}

	writeManifest(manifestPath, nextManifest);
	return { ...result, manifestPath };
}
