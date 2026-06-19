/**
 * Settings Loader — Read and merge Pi resources from settings files
 *
 * Reads `.pi/settings.json` from both project-level and global locations,
 * extracts the `packages`, `extensions`, and `skills` arrays, merges them
 * (project entries first, deduplicated), and filters out taskplane itself
 * from forwarded packages.
 *
 * Package resources keep two identities:
 *   - `source`: the stable settings/config value, e.g. `npm:pi-sage`
 *   - `loadSpec`: the value passed to `pi -e`; this resolves to Pi's managed
 *     package install root when available so spawned agents do not need a
 *     second temporary install to load already-installed tools.
 *
 * Used by spawn points (worker, reviewer, merge agent) to forward
 * user-installed extensions as explicit `-e` flags alongside `--no-extensions`
 * and explicit skills as `--skill` flags alongside `--no-skills`.
 *
 * @module taskplane/settings-loader
 * @since TP-180
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ── Constants ────────────────────────────────────────────────────────

/** Subpath under a project root for the project-level Pi settings file. */
const PROJECT_SETTINGS_SUBPATH = join(".pi", "settings.json");

/** Subpath under the global agent dir for the global Pi settings file. */
const GLOBAL_SETTINGS_SUBPATH = join(".pi", "agent", "settings.json");

// ── Internal Helpers ─────────────────────────────────────────────────

/**
 * Safely read and parse a JSON file, returning null on any failure.
 */
function readJsonSafe(filePath: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Extract package sources from a parsed settings object.
 * Returns an empty array if the key is missing or not an array.
 */
function isPackageObject(value: unknown): value is Record<string, unknown> & { source: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"source" in value &&
		typeof value.source === "string"
	);
}

function hasExtensionFilter(entry: Record<string, unknown>): boolean {
	return "extensions" in entry;
}

function resolveExplicitPath(entry: string, baseDir: string): string {
	if (entry === "~") return homedir();
	if (entry.startsWith("~/")) return resolve(homedir(), entry.slice(2));
	return isAbsolute(entry) || /^[a-z][a-z0-9+.-]*:/i.test(entry) ? entry : resolve(baseDir, entry);
}

function extractPackageSources(settings: Record<string, unknown> | null): string[] {
	if (!settings) return [];
	const packages = settings.packages;
	if (!Array.isArray(packages)) return [];
	return packages
		.map((entry) => {
			if (typeof entry === "string") return entry;
			if (isPackageObject(entry) && !hasExtensionFilter(entry)) {
				return entry.source;
			}
			return "";
		})
		.filter((source) => source.length > 0);
}

function parseNpmPackageName(source: string): string | null {
	if (!source.startsWith("npm:")) return null;
	const spec = source.slice("npm:".length).trim();
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	return match?.[1] ?? (spec || null);
}

function resolveInstalledNpmPackage(source: string, settingsBaseDir: string): string | null {
	const name = parseNpmPackageName(source);
	if (!name) return null;
	const installedPath = join(settingsBaseDir, "npm", "node_modules", name);
	return existsSync(installedPath) ? installedPath : null;
}

type PiSettingsScope = "project" | "global";

export interface PiSettingsPackageResource {
	source: string;
	identity: string;
	loadSpec: string;
	scope: PiSettingsScope;
}

function resolvePackageLoadSpec(source: string, settingsBaseDir: string): string {
	const installedNpmPackage = resolveInstalledNpmPackage(source, settingsBaseDir);
	if (installedNpmPackage) return installedNpmPackage;
	return /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : resolveExplicitPath(source, settingsBaseDir);
}

function packageIdentity(source: string, settingsBaseDir: string): string {
	const npmPackageName = parseNpmPackageName(source);
	if (npmPackageName) return `npm:${npmPackageName}`;
	return /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : resolveExplicitPath(source, settingsBaseDir);
}

function extractPackageResources(
	settings: Record<string, unknown> | null,
	settingsBaseDir: string,
	scope: PiSettingsScope,
): PiSettingsPackageResource[] {
	return extractPackageSources(settings).map((source) => ({
		source,
		identity: packageIdentity(source, settingsBaseDir),
		loadSpec: resolvePackageLoadSpec(source, settingsBaseDir),
		scope,
	}));
}

function mergePackageResources(
	projectEntries: PiSettingsPackageResource[],
	globalEntries: PiSettingsPackageResource[],
): PiSettingsPackageResource[] {
	const seen = new Set<string>();
	const merged: PiSettingsPackageResource[] = [];
	for (const entry of [...projectEntries, ...globalEntries]) {
		if (seen.has(entry.identity)) continue;
		seen.add(entry.identity);
		merged.push(entry);
	}
	return merged;
}

/** Extract a string array setting, returning an empty array when absent. */
function extractExplicitPaths(
	settings: Record<string, unknown> | null,
	key: string,
	baseDir: string,
): string[] {
	if (!settings) return [];
	const value = settings[key];
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		.map((entry) => resolveExplicitPath(entry, baseDir));
}

function mergeUnique(projectValues: string[], globalValues: string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of [...projectValues, ...globalValues]) {
		if (seen.has(value)) continue;
		seen.add(value);
		merged.push(value);
	}
	return merged;
}

function isTaskplanePackage(source: string): boolean {
	// Strip npm:/git: prefix to get the bare package name
	const bare = source.replace(/^(?:npm:|git:(?:github\.com\/[^/]+\/)?)/, "").toLowerCase();
	// Exact match on bare name, or scoped exact match (@scope/taskplane)
	return bare === "taskplane" || bare.endsWith("/taskplane");
}

function filterTaskplanePackageResources(
	packages: PiSettingsPackageResource[],
): PiSettingsPackageResource[] {
	return packages.filter((pkg) => !isTaskplanePackage(pkg.source));
}

export interface PiSettingsResources {
	packages: string[];
	packageLoadSpecs: string[];
	packageResources: PiSettingsPackageResource[];
	extensions: string[];
	skills: string[];
}

function isPackageExcluded(pkg: PiSettingsPackageResource, excludeSet: Set<string>): boolean {
	return excludeSet.has(pkg.source) || excludeSet.has(pkg.identity) || excludeSet.has(pkg.loadSpec);
}

/**
 * Resolve the global Pi agent settings path.
 *
 * Resolution order:
 *   1. `PI_CODING_AGENT_DIR` env → `<value>/settings.json`
 *   2. `os.homedir()/.pi/agent/settings.json`
 */
function resolveGlobalSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) {
		return join(agentDir, "settings.json");
	}
	return join(homedir(), GLOBAL_SETTINGS_SUBPATH);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load Pi resources from project and global settings files.
 *
 * Reads `.pi/settings.json` from the project root (stateRoot) and from
 * the global agent directory, merges the package lists (project first,
 * deduplicated), and filters out any package containing "taskplane"
 * (which is already loaded as the bridge extension). `packages` remains the
 * source string used by config/UI, while `packageLoadSpecs` is the launch-time
 * value passed to Pi.
 *
 * @param stateRoot - Project root directory (used to locate `.pi/settings.json`)
 * @returns Merged Pi resources, with package source and load identities.
 */
export function loadPiSettingsResources(stateRoot: string): PiSettingsResources {
	const projectSettingsPath = join(stateRoot, PROJECT_SETTINGS_SUBPATH);
	const projectSettingsBase = dirname(projectSettingsPath);
	const projectSettings = readJsonSafe(projectSettingsPath);

	const globalSettingsPath = resolveGlobalSettingsPath();
	const globalSettingsBase = dirname(globalSettingsPath);
	const globalSettings = readJsonSafe(globalSettingsPath);
	const packageResources = filterTaskplanePackageResources(
		mergePackageResources(
			extractPackageResources(projectSettings, projectSettingsBase, "project"),
			extractPackageResources(globalSettings, globalSettingsBase, "global"),
		),
	);

	return {
		packages: packageResources.map((pkg) => pkg.source),
		packageLoadSpecs: packageResources.map((pkg) => pkg.loadSpec),
		packageResources,
		extensions: mergeUnique(
			extractExplicitPaths(projectSettings, "extensions", projectSettingsBase),
			extractExplicitPaths(globalSettings, "extensions", globalSettingsBase),
		),
		skills: mergeUnique(
			extractExplicitPaths(projectSettings, "skills", projectSettingsBase),
			extractExplicitPaths(globalSettings, "skills", globalSettingsBase),
		),
	};
}

export function loadPiSettingsPackages(stateRoot: string): string[] {
	return loadPiSettingsResources(stateRoot).packages;
}

export function loadPiSettingsExtensions(stateRoot: string): string[] {
	return loadPiSettingsResources(stateRoot).extensions;
}

export function loadPiSettingsSkills(stateRoot: string): string[] {
	return loadPiSettingsResources(stateRoot).skills;
}

export function buildPiExtensionLoadSpecs(
	resources: PiSettingsResources,
	exclusions: string[] = [],
): string[] {
	const excludeSet = new Set(exclusions);
	const extensions = resources.extensions.filter((extension) => !excludeSet.has(extension));
	const packages = resources.packageResources
		.filter((pkg) => !isPackageExcluded(pkg, excludeSet))
		.map((pkg) => pkg.loadSpec);
	return [...extensions, ...packages];
}

/**
 * Filter out excluded extensions from a package list.
 *
 * @param packages - Full list of package specifiers
 * @param exclusions - Package specifiers to exclude (exact match)
 * @returns Filtered list with excluded packages removed
 */
export function filterExcludedExtensions(packages: string[], exclusions: string[]): string[] {
	if (!exclusions || exclusions.length === 0) return packages;
	const excludeSet = new Set(exclusions);
	return packages.filter((pkg) => !excludeSet.has(pkg));
}
