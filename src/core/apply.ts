import type { CrocConfig } from "./config.ts";
import { getBundledTaskplanePackagePath, getCrocProviderExtensionPath } from "./paths.ts";
import { writePiSettings } from "./pi-settings.ts";
import {
	collectSkillReferences,
	materializeSkills,
	type SkillDiagnostic,
	type SkillMaterializeResult,
	validateSkillsConfig,
} from "./skills.ts";
import { writeTaskplaneConfig } from "./taskplane-config.ts";
import { writeTaskplanePreferences } from "./taskplane-preferences.ts";
import {
	materializeWorkBundle,
	validateWorkBundleConfig,
	type WorkBundleDiagnostic,
	type WorkBundleResult,
} from "./work-bundles.ts";
import { prepareWorkspace, type RuntimeContext } from "./workspace.ts";

export interface ApplyResult {
	taskplaneConfigPath: string;
	piSettingsPath: string;
	taskplanePreferencesPath?: string;
	providerExtensionPath: string;
	runtimeRoot: string;
	workspace?: RuntimeContext["workspace"];
	workspaceFiles: string[];
	createdRepos: string[];
	skills: SkillMaterializeResult;
	work: WorkBundleResult;
}

function assertNoValidationErrors(diagnostics: Array<SkillDiagnostic | WorkBundleDiagnostic>): void {
	const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
}

function getSkillFiles(cwd: string, config: CrocConfig, configPath: string): Record<string, string> {
	const references = collectSkillReferences(cwd, config, configPath).references;
	const skillFiles: Record<string, string> = {};
	for (const [name, reference] of references) skillFiles[name] = reference.filePath;
	return skillFiles;
}

export function applyConfig(cwd: string, config: CrocConfig, configPath: string): ApplyResult {
	const workspace = prepareWorkspace(cwd, config, configPath);
	const runtimeConfig = workspace.context.config;
	const runtimeRoot = workspace.context.root;
	const providerExtensionPath = getCrocProviderExtensionPath();
	const bundledTaskplanePackagePath = getBundledTaskplanePackagePath();
	const skillFiles = getSkillFiles(runtimeRoot, runtimeConfig, configPath);
	assertNoValidationErrors([
		...validateSkillsConfig(runtimeRoot, runtimeConfig, configPath),
		...validateWorkBundleConfig(runtimeRoot, runtimeConfig, configPath, { skillFiles }),
	]);
	const skills = materializeSkills(runtimeRoot, runtimeConfig, configPath);
	const taskplaneConfigPath = writeTaskplaneConfig(runtimeRoot, runtimeConfig);
	const piSettingsPath = writePiSettings(
		runtimeRoot,
		runtimeConfig,
		providerExtensionPath,
		bundledTaskplanePackagePath,
		skills.settingsPaths,
	);
	const taskplanePreferencesPath = writeTaskplanePreferences(runtimeConfig);
	const work = materializeWorkBundle(runtimeRoot, runtimeConfig, configPath, { skillFiles: skills.skillFiles });
	return {
		taskplaneConfigPath,
		piSettingsPath,
		providerExtensionPath,
		runtimeRoot,
		workspace: workspace.context.workspace,
		workspaceFiles: workspace.written,
		createdRepos: workspace.createdRepos,
		skills,
		work,
		...(taskplanePreferencesPath ? { taskplanePreferencesPath } : {}),
	};
}
