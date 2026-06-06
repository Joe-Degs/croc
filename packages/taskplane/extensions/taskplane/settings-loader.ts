/**
 * Settings Loader — Read and merge Pi resources from settings files
 *
 * Reads `.pi/settings.json` from both project-level and global locations,
 * extracts the `packages`, `extensions`, and `skills` arrays, merges them
 * (project entries first, deduplicated), and filters out taskplane itself
 * from forwarded packages.
 *
 * Used by spawn points (worker, reviewer, merge agent) to forward
 * user-installed extensions as explicit `-e` flags alongside `--no-extensions`
 * and explicit skills as `--skill` flags alongside `--no-skills`.
 *
 * @module taskplane/settings-loader
 * @since TP-180
 */

import { readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";

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

function extractPackages(settings: Record<string, unknown> | null): string[] {
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

function filterTaskplanePackages(packages: string[]): string[] {
	return packages.filter((pkg) => {
		// Strip npm:/git: prefix to get the bare package name
		const bare = pkg.replace(/^(?:npm:|git:(?:github\.com\/[^/]+\/)?)/, "").toLowerCase();
		// Exact match on bare name, or scoped exact match (@scope/taskplane)
		return bare !== "taskplane" && !bare.endsWith("/taskplane");
	});
}

export interface PiSettingsResources {
	packages: string[];
	extensions: string[];
	skills: string[];
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
 * Load Pi extension packages from project and global settings files.
 *
 * Reads `.pi/settings.json` from the project root (stateRoot) and from
 * the global agent directory, merges the package lists (project first,
 * deduplicated), and filters out any package containing "taskplane"
 * (which is already loaded as the bridge extension).
 *
 * @param stateRoot - Project root directory (used to locate `.pi/settings.json`)
 * @returns Array of package specifiers (e.g., `["npm:pi-sage"]`) or empty array
 */
export function loadPiSettingsResources(stateRoot: string): PiSettingsResources {
	const projectSettingsPath = join(stateRoot, PROJECT_SETTINGS_SUBPATH);
	const projectSettingsBase = dirname(projectSettingsPath);
	const projectSettings = readJsonSafe(projectSettingsPath);

	const globalSettingsPath = resolveGlobalSettingsPath();
	const globalSettingsBase = dirname(globalSettingsPath);
	const globalSettings = readJsonSafe(globalSettingsPath);

	return {
		packages: filterTaskplanePackages(
			mergeUnique(extractPackages(projectSettings), extractPackages(globalSettings)),
		),
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
