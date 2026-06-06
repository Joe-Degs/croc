import { join } from "node:path";
import type { CrocConfig } from "./config.ts";
import { readJsonObject, writeJson } from "./config.ts";

type PackageSource =
	| string
	| { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] };

function packageKey(source: PackageSource): string {
	return typeof source === "string" ? source : source.source;
}

function addUniquePackage(packages: PackageSource[], source: string): PackageSource[] {
	if (packages.some((entry) => packageKey(entry) === source)) return packages;
	return [...packages, source];
}

function normalizedSource(source: string): string {
	return source.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isTaskplanePackageSource(source: string): boolean {
	const bare = normalizedSource(source)
		.replace(/^(?:npm:|file:|git:(?:github\.com\/[^/]+\/)?)/, "")
		.toLowerCase();
	return bare === "taskplane" || bare.endsWith("/taskplane");
}

function isCrocProviderExtensionPath(path: string): boolean {
	const normalized = normalizedSource(path);
	return normalized.endsWith("/dist/extensions/provider.js") || normalized.endsWith("/src/extensions/provider.ts");
}

function resolveTaskplanePackageSource(config: CrocConfig, bundledTaskplanePackagePath: string): string {
	if (config.taskplane.packageSource === "bundled") {
		return bundledTaskplanePackagePath;
	}
	return config.taskplane.packageSource;
}

function addUniqueString(values: string[], value: string): string[] {
	if (values.includes(value)) return values;
	return [...values, value];
}

function readPackageArray(value: unknown): PackageSource[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is PackageSource => {
		if (typeof entry === "string") return true;
		return typeof entry === "object" && entry !== null && "source" in entry && typeof entry.source === "string";
	});
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function splitModel(model: string): { provider?: string; model: string } {
	const index = model.indexOf("/");
	if (index < 0) return { model };
	return { provider: model.slice(0, index), model: model.slice(index + 1) };
}

export function getPiSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

export function writePiSettings(
	cwd: string,
	config: CrocConfig,
	extensionPath: string,
	bundledTaskplanePackagePath: string,
	skillPaths: string[] = [],
): string {
	const path = getPiSettingsPath(cwd);
	const settings = readJsonObject(path);
	let packages = readPackageArray(settings.packages).filter((entry) => !isTaskplanePackageSource(packageKey(entry)));
	let extensions = readStringArray(settings.extensions).filter((entry) => !isCrocProviderExtensionPath(entry));

	if (config.taskplane.enabled) {
		packages = addUniquePackage(packages, resolveTaskplanePackageSource(config, bundledTaskplanePackagePath));
	}
	if (config.batteries.webSearch.enabled) {
		packages = addUniquePackage(packages, config.batteries.webSearch.packageSource);
	}
	if (config.batteries.piLens.enabled) {
		packages = addUniquePackage(packages, config.batteries.piLens.packageSource);
	}
	extensions = addUniqueString(extensions, extensionPath);
	const skills = config.skills.enabled ? [...new Set(skillPaths)] : [];
	settings.enableSkillCommands = config.skills.enabled && config.skills.enableCommands;

	settings.packages = packages;
	settings.extensions = extensions;
	settings.skills = skills;
	if (config.pi.model) {
		const model = splitModel(config.pi.model);
		settings.defaultModel = model.model;
		if (model.provider) settings.defaultProvider = model.provider;
	}
	if (config.pi.thinking) {
		settings.defaultThinkingLevel = config.pi.thinking;
	}

	writeJson(path, settings);
	return path;
}
