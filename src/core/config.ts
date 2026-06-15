import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const APP_NAME = "croc";
export const VERSION = "0.3.0";
export const CONFIG_FILE_NAME = "croc.json";
export const CONFIG_FILE_NAMES = ["croc.yaml", "croc.yml", CONFIG_FILE_NAME] as const;
export const CROC_CONFIG_VERSION = 1;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type WorktreeLocation = "subdirectory" | "sibling";
export type IntegrationMode = "manual" | "supervised" | "auto";
export type SupervisorAutonomy = "interactive" | "supervised" | "autonomous";
export type WorkOverwrite = "never" | "if-generated" | "always";
export type TaskSize = "S" | "M" | "L";
export type WorkspaceRepoMode = "create" | "clone" | "attach";
export type CompactionKillPolicy = "immediate" | "defer";

export type CrocPiProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1] | Record<string, unknown>;

export interface CrocPiModelsConfig {
	file: string;
	providers: Record<string, CrocPiProviderConfig>;
}

export type HeadroomProxyMode = "managed" | "external";
export type HeadroomTelemetryMode = "off" | "on";
export type HeadroomTarget = "openai" | "anthropic" | "gemini" | "cloudcode";
export type HeadroomCcrMode = "disabled" | "bridge";

export interface CrocHeadroomTargetConfig {
	upstreamUrl: string;
}

export interface CrocHeadroomConfig {
	enabled: boolean;
	proxy: {
		mode: HeadroomProxyMode;
		command: string;
		url: string;
		telemetry: HeadroomTelemetryMode;
		requireReady: boolean;
		startupTimeoutSeconds: number;
		targets: Partial<Record<HeadroomTarget, CrocHeadroomTargetConfig>>;
	};
	routing: {
		providers: Record<string, { target: HeadroomTarget }>;
	};
	ccr: {
		mode: HeadroomCcrMode;
		timeoutSeconds: number;
		maxResultBytes: number;
		trustedOrigins: string[];
	};
}

export interface CrocRuntimeConfig {
	tmux: {
		enabled: boolean;
		session: string;
		attach: boolean;
	};
}

export interface CrocPiConfig {
	command: string;
	model: string;
	thinking: "" | ThinkingLevel;
	name: string;
	extraArgs: string[];
	models: CrocPiModelsConfig;
}

export interface CrocTaskplaneConfig {
	enabled: boolean;
	packageSource: string;
	projectName: string;
	projectDescription: string;
	tasksPath: string;
	taskPrefix: string;
	maxLanes: number;
	worktreeLocation: WorktreeLocation;
	worktreePrefix: string;
	sessionPrefix: string;
	integration: IntegrationMode;
	workerModel: string;
	reviewerModel: string;
	mergeModel: string;
	supervisorModel: string;
	workerThinking: "" | ThinkingLevel;
	reviewerThinking: "" | ThinkingLevel;
	mergeThinking: "" | ThinkingLevel;
	supervisorAutonomy: SupervisorAutonomy;
	maxWorkerMinutes: number;
	stallTimeoutMinutes: number;
	maxWorkerIterations: number;
	compactionKillPolicy: CompactionKillPolicy;
	mergeVerify: string[];
	testingCommands: Record<string, string>;
	dashboard: {
		enabled: boolean;
		host: string;
		port: number;
		applyGlobalPreference: boolean;
		pidFile: string;
	};
}

export interface CrocWorkspaceRepoConfig {
	id: string;
	mode: WorkspaceRepoMode;
	path: string;
	remote?: string;
	initialBranch?: string;
	initialCommit?: boolean;
}

export interface CrocWorkspaceConfig {
	enabled: boolean;
	root: string;
	defaultRepo: string;
	taskPacketRepo: string;
	strictRouting: boolean;
	repos: CrocWorkspaceRepoConfig[];
}

export type CrocContentSource = string | { inline?: string; file?: string };

export interface CrocInlineSkillConfig {
	name: string;
	description: string;
	body: CrocContentSource;
	disableModelInvocation?: boolean;
	allowedTools?: string;
	compatibility?: string;
	license?: string;
	metadata?: Record<string, string | number | boolean>;
}

export interface CrocSkillsConfig {
	enabled: boolean;
	enableCommands: boolean;
	bundled: string[];
	paths: string[];
	inline: CrocInlineSkillConfig[];
	work: {
		include: string[];
	};
}

export interface CrocWorkDirectorySource {
	directory: string;
	mode: "copy";
}

export interface CrocWorkTaskConfig {
	id: string;
	title: string;
	repo?: string;
	skills?: string[];
	folder?: string;
	size?: TaskSize;
	reviewLevel?: number;
	dependencies?: string[];
	contextDocs?: string[];
	fileScope?: string[];
	prompt: CrocContentSource;
}

export interface CrocWorkConfig {
	enabled: boolean;
	overwrite: WorkOverwrite;
	context?: CrocContentSource;
	sources: CrocWorkDirectorySource[];
	tasks: CrocWorkTaskConfig[];
}

export interface CrocBatteriesConfig {
	webSearch: {
		enabled: boolean;
		packageSource: string;
		provider: "searxng";
		url: string;
		apiKeyEnv: string;
	};
	piLens: {
		enabled: boolean;
		packageSource: string;
	};
	headroom: CrocHeadroomConfig;
}

export interface CrocConfig {
	configVersion: number;
	profile: string;
	runtime: CrocRuntimeConfig;
	workspace: CrocWorkspaceConfig;
	skills: CrocSkillsConfig;
	pi: CrocPiConfig;
	taskplane: CrocTaskplaneConfig;
	work: CrocWorkConfig;
	batteries: CrocBatteriesConfig;
}

export type DeepPartial<T> = T extends Array<infer U>
	? Array<DeepPartial<U>>
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;

export interface LoadedConfig {
	path: string;
	config: CrocConfig;
}

function getDefaultSessionName(projectName: string): string {
	return `croc-${projectName}`.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "croc";
}

export function createDefaultConfig(cwd: string): CrocConfig {
	const projectName = basename(resolve(cwd)) || "project";
	const sessionName = getDefaultSessionName(projectName);
	return {
		configVersion: CROC_CONFIG_VERSION,
		profile: "yolo-vm",
		runtime: {
			tmux: {
				enabled: true,
				session: sessionName,
				attach: true,
			},
		},
		workspace: {
			enabled: false,
			root: ".croc/workspace",
			defaultRepo: projectName,
			taskPacketRepo: "packets",
			strictRouting: true,
			repos: [],
		},
		skills: {
			enabled: true,
			enableCommands: true,
			bundled: ["croc-workflow"],
			paths: [],
			inline: [],
			work: {
				include: ["croc-workflow"],
			},
		},
		pi: {
			command: "pi",
			model: "",
			thinking: "",
			name: sessionName,
			extraArgs: [],
			models: {
				file: "",
				providers: {},
			},
		},
		taskplane: {
			enabled: true,
			packageSource: "bundled",
			projectName,
			projectDescription: "",
			tasksPath: "taskplane-tasks",
			taskPrefix: "TASK",
			maxLanes: 3,
			worktreeLocation: "subdirectory",
			worktreePrefix: "taskplane-wt",
			sessionPrefix: "croc",
			integration: "manual",
			workerModel: "",
			reviewerModel: "",
			mergeModel: "",
			supervisorModel: "",
			workerThinking: "",
			reviewerThinking: "",
			mergeThinking: "",
			supervisorAutonomy: "autonomous",
			maxWorkerMinutes: 1440,
			stallTimeoutMinutes: 120,
			maxWorkerIterations: 50,
			compactionKillPolicy: "immediate",
			mergeVerify: [],
			testingCommands: {},
			dashboard: {
				enabled: true,
				host: "127.0.0.1",
				port: 8099,
				applyGlobalPreference: false,
				pidFile: ".croc/dashboard.pid",
			},
		},
		work: {
			enabled: false,
			overwrite: "if-generated",
			sources: [],
			tasks: [],
		},
		batteries: {
			webSearch: {
				enabled: false,
				packageSource: "npm:@juicesharp/rpiv-web-tools",
				provider: "searxng",
				url: "",
				apiKeyEnv: "SEARXNG_API_KEY",
			},
			piLens: {
				enabled: false,
				packageSource: "npm:pi-lens",
			},
			headroom: {
				enabled: false,
				proxy: {
					mode: "managed",
					command: "headroom",
					url: "",
					telemetry: "off",
					requireReady: true,
					startupTimeoutSeconds: 120,
					targets: {},
				},
				routing: {
					providers: {},
				},
				ccr: {
					mode: "disabled",
					timeoutSeconds: 10,
					maxResultBytes: 65536,
					trustedOrigins: [],
				},
			},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObjects(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (Array.isArray(base) || Array.isArray(override)) return override;
	if (!isRecord(base) || !isRecord(override)) return override;
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		result[key] = mergeObjects(result[key], value);
	}
	return result;
}

export function mergeConfig(defaults: CrocConfig, override: DeepPartial<CrocConfig>): CrocConfig {
	return mergeObjects(defaults, override) as CrocConfig;
}

export function hasConfiguredPiModels(config: Pick<CrocConfig, "pi">): boolean {
	return config.pi.models.file.length > 0 || Object.keys(config.pi.models.providers).length > 0;
}

function isCompactionKillPolicy(value: unknown): value is CompactionKillPolicy {
	return value === "immediate" || value === "defer";
}

function validateConfig(config: CrocConfig): void {
	if (!isCompactionKillPolicy(config.taskplane.compactionKillPolicy)) {
		throw new Error(
			`Invalid taskplane.compactionKillPolicy ${JSON.stringify(config.taskplane.compactionKillPolicy)}; expected "immediate" or "defer".`,
		);
	}
}

export function getConfigPath(cwd: string, explicitPath?: string): string {
	if (explicitPath) return resolve(explicitPath);
	return findConfigPath(cwd) ?? join(resolve(cwd), "croc.yaml");
}

export function findConfigPath(cwd: string): string | undefined {
	const root = resolve(cwd);
	const matches = CONFIG_FILE_NAMES.map((name) => join(root, name)).filter((path) => existsSync(path));
	if (matches.length > 1) {
		throw new Error(`Multiple Croc config files found: ${matches.join(", ")}. Use --config to choose one.`);
	}
	return matches[0];
}

export function loadConfig(cwd: string, explicitPath?: string): LoadedConfig {
	const path = getConfigPath(cwd, explicitPath);
	if (!existsSync(path)) {
		throw new Error(`No Croc config found at ${path}. Run ${APP_NAME} init first.`);
	}
	const raw = readConfigObject(path) as DeepPartial<CrocConfig>;
	const config = mergeConfig(createDefaultConfig(dirname(path)), raw);
	if (config.configVersion !== CROC_CONFIG_VERSION) {
		throw new Error(`Unsupported Croc config version ${config.configVersion}; expected ${CROC_CONFIG_VERSION}.`);
	}
	validateConfig(config);
	return { path, config };
}

export function writeDefaultConfig(cwd: string, explicitPath: string | undefined, force: boolean): string {
	const path = getConfigPath(cwd, explicitPath);
	if (existsSync(path) && !force) {
		throw new Error(`${path} already exists. Use --force to overwrite it.`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeConfigFile(path, createDefaultConfig(dirname(path)));
	return path;
}

function isYamlPath(path: string): boolean {
	const extension = extname(path).toLowerCase();
	return extension === ".yaml" || extension === ".yml";
}

function readConfigObject(path: string): Record<string, unknown> {
	const raw = readFileSync(path, "utf-8");
	const parsed = isYamlPath(path) ? parseYaml(raw) : JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error(`${path} must contain a config object.`);
	}
	return parsed;
}

function writeConfigFile(path: string, value: unknown): void {
	if (isYamlPath(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, stringifyYaml(value), "utf-8");
		return;
	}
	writeJson(path, value);
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
}

export function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`${path} must contain a JSON object.`);
	}
	return parsed;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
