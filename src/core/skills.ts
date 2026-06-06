import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CrocConfig, CrocContentSource, CrocInlineSkillConfig } from "./config.ts";
import { readJsonObject, writeJson } from "./config.ts";
import { getPackageRoot } from "./paths.ts";

export interface SkillReference {
	name: string;
	description: string;
	filePath: string;
	source: string;
}

export interface SkillMaterializeResult {
	manifestPath?: string;
	written: string[];
	skipped: string[];
	removed: string[];
	settingsPaths: string[];
	skillFiles: Record<string, string>;
}

export interface SkillDiagnostic {
	type: "warning" | "error";
	message: string;
}

interface SkillManifestFile {
	sha256: string;
	source: string;
}

interface SkillManifest {
	version: 1;
	generatedAt: string;
	files: Record<string, SkillManifestFile>;
}

interface ParsedSkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getSkillsManifestPath(cwd: string): string {
	return join(cwd, ".croc", "skills-manifest.json");
}

export function getInlineSkillsRoot(cwd: string): string {
	return join(cwd, ".pi", "skills");
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

function readManifest(path: string): SkillManifest {
	if (!existsSync(path)) return { version: 1, generatedAt: new Date().toISOString(), files: {} };
	const raw = readJsonObject(path);
	const files = isRecord(raw.files) ? raw.files : {};
	const manifestFiles: Record<string, SkillManifestFile> = {};
	for (const [filePath, entry] of Object.entries(files)) {
		if (!isRecord(entry)) continue;
		if (typeof entry.sha256 !== "string" || typeof entry.source !== "string") continue;
		manifestFiles[filePath] = { sha256: entry.sha256, source: entry.source };
	}
	return { version: 1, generatedAt: String(raw.generatedAt ?? new Date().toISOString()), files: manifestFiles };
}

function resolveContent(source: CrocContentSource, configPath: string, label: string): string {
	if (typeof source === "string") return source;
	const hasInline = typeof source.inline === "string";
	const hasFile = typeof source.file === "string" && source.file.length > 0;
	if (hasInline && hasFile) throw new Error(`${label} cannot define both inline and file.`);
	if (hasInline) return source.inline!;
	if (hasFile) return readFileSync(resolveFromConfig(configPath, source.file!), "utf-8");
	throw new Error(`${label} must define inline or file.`);
}

function validateSkillName(name: string): string | undefined {
	if (!SKILL_NAME_PATTERN.test(name)) {
		return `${name} must contain lowercase letters, numbers, and single hyphens only.`;
	}
	if (name.length > 64) return `${name} exceeds 64 characters.`;
	return undefined;
}

function formatInlineSkill(skill: CrocInlineSkillConfig, configPath: string): string {
	const frontmatter: Record<string, unknown> = {
		name: skill.name,
		description: skill.description,
	};
	if (skill.disableModelInvocation !== undefined) {
		frontmatter["disable-model-invocation"] = skill.disableModelInvocation;
	}
	if (skill.allowedTools) frontmatter["allowed-tools"] = skill.allowedTools;
	if (skill.compatibility) frontmatter.compatibility = skill.compatibility;
	if (skill.license) frontmatter.license = skill.license;
	if (skill.metadata) frontmatter.metadata = skill.metadata;

	return [
		"---",
		stringifyYaml(frontmatter).trimEnd(),
		"---",
		"",
		resolveContent(skill.body, configPath, `skills.inline.${skill.name}.body`).trim(),
		"",
	].join("\n");
}

function writeManagedFile(
	cwd: string,
	path: string,
	content: string,
	source: string,
	previousManifest: SkillManifest,
	nextManifest: SkillManifest,
	result: SkillMaterializeResult,
): void {
	const normalizedContent = ensureTrailingNewline(content);
	const nextHash = sha256(normalizedContent);
	const rel = relativePath(cwd, path);

	if (existsSync(path)) {
		const current = readFileSync(path);
		const currentHash = sha256(current);
		if (currentHash === nextHash) {
			nextManifest.files[rel] = { sha256: nextHash, source };
			result.skipped.push(rel);
			return;
		}
		const previous = previousManifest.files[rel];
		if (!previous) {
			throw new Error(`${rel} already exists and is not recorded in .croc/skills-manifest.json.`);
		}
		if (previous.sha256 !== currentHash) {
			throw new Error(`${rel} was modified outside Croc; refusing to overwrite it.`);
		}
	}

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, normalizedContent, "utf-8");
	nextManifest.files[rel] = { sha256: nextHash, source };
	result.written.push(rel);
}

function removeManagedFile(
	cwd: string,
	path: string,
	previous: SkillManifestFile,
	result: SkillMaterializeResult,
): void {
	const rel = relativePath(cwd, path);
	const removeEmptyParent = (): void => {
		const parent = dirname(path);
		if (existsSync(parent) && statSync(parent).isDirectory() && readdirSync(parent).length === 0) {
			rmdirSync(parent);
		}
	};
	if (!existsSync(path)) {
		removeEmptyParent();
		return;
	}
	const currentHash = sha256(readFileSync(path));
	if (previous.sha256 !== currentHash) {
		throw new Error(`${rel} was modified outside Croc; refusing to remove it.`);
	}
	rmSync(path);
	removeEmptyParent();
	result.removed.push(rel);
}

function removeStaleManagedFiles(
	cwd: string,
	previousManifest: SkillManifest,
	nextManifest: SkillManifest,
	result: SkillMaterializeResult,
): void {
	for (const [rel, previous] of Object.entries(previousManifest.files)) {
		if (nextManifest.files[rel]) continue;
		removeManagedFile(cwd, join(cwd, rel), previous, result);
	}
}

function parseSkillFrontmatter(filePath: string): ParsedSkillFrontmatter {
	const content = readFileSync(filePath, "utf-8");
	if (!content.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end < 0) return {};
	const parsed = parseYaml(content.slice(3, end)) as unknown;
	return isRecord(parsed) ? (parsed as ParsedSkillFrontmatter) : {};
}

function readSkillReference(
	filePath: string,
	source: string,
	diagnostics: SkillDiagnostic[],
): SkillReference | undefined {
	const frontmatter = parseSkillFrontmatter(filePath);
	const name = typeof frontmatter.name === "string" ? frontmatter.name : basename(dirname(filePath));
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description.trim()) {
		diagnostics.push({ type: "error", message: `Skill ${filePath} needs a description.` });
		return undefined;
	}
	return { name, description, filePath, source };
}

function discoverSkillFiles(path: string, includeRootFiles = true): string[] {
	if (!existsSync(path)) return [];
	const stat = statSync(path);
	if (stat.isFile()) return path.endsWith(".md") ? [path] : [];
	if (!stat.isDirectory()) return [];

	const skillFile = join(path, "SKILL.md");
	if (existsSync(skillFile) && statSync(skillFile).isFile()) return [skillFile];

	const files: string[] = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const entryPath = join(path, entry.name);
		if (entry.isDirectory()) {
			files.push(...discoverSkillFiles(entryPath, false));
		} else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) {
			files.push(entryPath);
		}
	}
	return files;
}

function addReference(
	references: Map<string, SkillReference>,
	diagnostics: SkillDiagnostic[],
	reference: SkillReference | undefined,
): void {
	if (!reference) return;
	const nameError = validateSkillName(reference.name);
	if (nameError) diagnostics.push({ type: "error", message: `Skill ${nameError}` });
	const existing = references.get(reference.name);
	if (existing) {
		diagnostics.push({
			type: "error",
			message: `Duplicate skill name ${reference.name}: ${existing.filePath} and ${reference.filePath}`,
		});
		return;
	}
	references.set(reference.name, reference);
}

export function collectSkillReferences(
	cwd: string,
	config: CrocConfig,
	configPath: string,
): {
	references: Map<string, SkillReference>;
	settingsPaths: string[];
	diagnostics: SkillDiagnostic[];
} {
	const references = new Map<string, SkillReference>();
	const settingsPaths: string[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	if (!config.skills.enabled) return { references, settingsPaths, diagnostics };

	for (const name of config.skills.bundled) {
		const nameError = validateSkillName(name);
		if (nameError) diagnostics.push({ type: "error", message: `Bundled skill ${nameError}` });
		const skillDir = join(getPackageRoot(), "skills", name);
		const skillFile = join(skillDir, "SKILL.md");
		if (!existsSync(skillFile)) {
			diagnostics.push({ type: "error", message: `Bundled skill not found: ${name}` });
			continue;
		}
		settingsPaths.push(skillDir);
		addReference(references, diagnostics, readSkillReference(skillFile, `bundled:${name}`, diagnostics));
	}

	if (config.skills.inline.length > 0) {
		settingsPaths.push(getInlineSkillsRoot(cwd));
	}
	for (const skill of config.skills.inline) {
		const nameError = validateSkillName(skill.name);
		if (nameError) diagnostics.push({ type: "error", message: `Inline skill ${nameError}` });
		if (!skill.description.trim())
			diagnostics.push({ type: "error", message: `Inline skill ${skill.name} needs a description.` });
		try {
			resolveContent(skill.body, configPath, `skills.inline.${skill.name}.body`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({ type: "error", message });
		}
		addReference(references, diagnostics, {
			name: skill.name,
			description: skill.description,
			filePath: join(getInlineSkillsRoot(cwd), skill.name, "SKILL.md"),
			source: `inline:${skill.name}`,
		});
	}

	for (const path of config.skills.paths) {
		const resolvedPath = resolveFromConfig(configPath, path);
		settingsPaths.push(resolvedPath);
		if (!existsSync(resolvedPath)) {
			diagnostics.push({ type: "error", message: `Skill path does not exist: ${resolvedPath}` });
			continue;
		}
		const files = discoverSkillFiles(resolvedPath);
		if (files.length === 0)
			diagnostics.push({ type: "warning", message: `Skill path has no skill files: ${resolvedPath}` });
		for (const file of files) {
			addReference(references, diagnostics, readSkillReference(file, `path:${resolvedPath}`, diagnostics));
		}
	}

	return { references, settingsPaths: [...new Set(settingsPaths)], diagnostics };
}

export function validateSkillsConfig(cwd: string, config: CrocConfig, configPath: string): SkillDiagnostic[] {
	const collected = collectSkillReferences(cwd, config, configPath);
	if (!config.skills.enabled) return collected.diagnostics;
	for (const skill of config.skills.work.include ?? []) {
		if (!collected.references.has(skill)) {
			collected.diagnostics.push({
				type: "error",
				message: `skills.work.include references unknown skill: ${skill}`,
			});
		}
	}
	return collected.diagnostics;
}

export function materializeSkills(cwd: string, config: CrocConfig, configPath: string): SkillMaterializeResult {
	const result: SkillMaterializeResult = { written: [], skipped: [], removed: [], settingsPaths: [], skillFiles: {} };
	const manifestPath = getSkillsManifestPath(cwd);
	const hasManifest = existsSync(manifestPath);
	const previousManifest = readManifest(manifestPath);
	const nextManifest: SkillManifest = {
		version: 1,
		generatedAt: new Date().toISOString(),
		files: {},
	};
	if (!config.skills.enabled) {
		removeStaleManagedFiles(cwd, previousManifest, nextManifest, result);
		if (hasManifest || result.removed.length > 0) writeJson(manifestPath, nextManifest);
		return { ...result, ...(hasManifest || result.removed.length > 0 ? { manifestPath } : {}) };
	}

	const diagnostics = collectSkillReferences(cwd, config, configPath).diagnostics;
	const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));

	if (config.skills.inline.length > 0) {
		for (const skill of config.skills.inline) {
			const path = join(getInlineSkillsRoot(cwd), skill.name, "SKILL.md");
			writeManagedFile(
				cwd,
				path,
				formatInlineSkill(skill, configPath),
				`inline:${skill.name}`,
				previousManifest,
				nextManifest,
				result,
			);
		}
	}
	removeStaleManagedFiles(cwd, previousManifest, nextManifest, result);
	if (config.skills.inline.length > 0 || hasManifest || result.removed.length > 0)
		writeJson(manifestPath, nextManifest);

	const collected = collectSkillReferences(cwd, config, configPath);
	result.settingsPaths = collected.settingsPaths;
	for (const [name, reference] of collected.references) result.skillFiles[name] = reference.filePath;
	return {
		...result,
		...(config.skills.inline.length > 0 || hasManifest || result.removed.length > 0 ? { manifestPath } : {}),
	};
}
