import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { applyConfig } from "../core/apply.ts";
import {
	type CrocConfig,
	type CrocProviderConfig,
	type CrocProviderModelConfig,
	createDefaultConfig,
	type DeepPartial,
	mergeConfig,
} from "../core/config.ts";
import { getDashboardState, getDashboardUrl, startDashboard, stopDashboard } from "../core/dashboard.ts";
import { runDoctor } from "../core/doctor.ts";
import { resolveRuntimeContext } from "../core/workspace.ts";

interface CrocSessionRepo {
	id?: string;
	mode?: string;
	path?: string;
	generated?: boolean;
}

interface CrocSession {
	profile?: string;
	configPath?: string;
	sourceRoot?: string;
	workspace?: {
		root?: string;
		tasksRoot?: string;
		tasksPath?: string;
		defaultRepo?: string;
		taskPacketRepo?: string;
		strictRouting?: boolean;
		repos?: CrocSessionRepo[];
	};
}

type DashboardAction = "start" | "stop" | "status";

interface ActiveRuntime {
	config?: CrocConfig;
	configPath?: string;
	session?: CrocSession;
	sourceRoot: string;
	runtimeRoot: string;
}

interface TextToolParams {
	[key: string]: unknown;
}

interface TextToolDefinition {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: Record<string, unknown>;
	execute(ctx: { cwd: string }, params: TextToolParams): string;
}

const emptyParameters = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const dashboardParameters = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["start", "stop", "status"],
			description: "Dashboard action to run.",
		},
	},
	required: ["action"],
	additionalProperties: false,
};

const applyParameters = {
	type: "object",
	properties: {
		confirm: {
			type: "boolean",
			description: "Set true only after the operator explicitly confirms Croc may rewrite generated runtime files.",
		},
	},
	additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStructuredFile(path: string): unknown {
	const raw = readFileSync(path, "utf-8");
	const extension = extname(path).toLowerCase();
	return extension === ".yaml" || extension === ".yml" ? parseYaml(raw) : JSON.parse(raw);
}

function readConfig(path: string | undefined): CrocConfig | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		const parsed = parseStructuredFile(path);
		if (!isRecord(parsed)) return undefined;
		return mergeConfig(createDefaultConfig(dirname(path)), parsed as DeepPartial<CrocConfig>);
	} catch {
		return undefined;
	}
}

function resolveMaybeRelative(cwd: string, path: string | undefined): string | undefined {
	return path ? resolve(cwd, path) : undefined;
}

function resolveActiveRuntime(cwd: string, fallbackConfig: CrocConfig | undefined): ActiveRuntime {
	const session = readSession(cwd);
	const configPath = resolveMaybeRelative(cwd, session?.configPath) ?? process.env.CROC_CONFIG;
	const config = readConfig(configPath) ?? fallbackConfig;
	const sourceRoot = resolveMaybeRelative(cwd, session?.sourceRoot) ?? cwd;
	let runtimeRoot = resolveMaybeRelative(cwd, session?.workspace?.root) ?? cwd;
	if (config) {
		try {
			runtimeRoot = resolveRuntimeContext(sourceRoot, config).root;
		} catch {
			if (!session?.workspace?.root) runtimeRoot = cwd;
		}
	}
	return { config, configPath, session, sourceRoot, runtimeRoot };
}

function readSession(cwd: string): CrocSession | undefined {
	const path = join(cwd, ".croc", "session.json");
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return isRecord(parsed) ? (parsed as CrocSession) : undefined;
	} catch {
		return undefined;
	}
}

function workspaceConfigExists(cwd: string): boolean {
	return existsSync(join(cwd, ".pi", "taskplane-workspace.yaml"));
}

function formatRepo(repo: CrocSessionRepo): string {
	const id = repo.id ?? "unknown";
	const mode = repo.generated ? `${repo.mode ?? "create"}, generated` : (repo.mode ?? "unknown");
	return `- ${id}: ${repo.path ?? "unknown"} (${mode})`;
}

function buildStatus(config: CrocConfig | undefined, session: CrocSession | undefined, cwd: string): string {
	const profile = session?.profile ?? config?.profile ?? process.env.CROC_PROFILE ?? "unknown";
	const workspace = session?.workspace;
	if (!workspace) {
		return [`Croc profile: ${profile}`, `Runtime root: ${cwd}`, "Workspace mode: off"].join("\n");
	}
	const repos =
		Array.isArray(workspace.repos) && workspace.repos.length > 0
			? workspace.repos.map(formatRepo).join("\n")
			: "- none";
	return [
		`Croc profile: ${profile}`,
		`Runtime root: ${workspace.root ?? cwd}`,
		`Config: ${session?.configPath ?? process.env.CROC_CONFIG ?? "unknown"}`,
		`Source root: ${session?.sourceRoot ?? "unknown"}`,
		`Task packets: ${workspace.tasksPath ?? config?.taskplane?.tasksPath ?? "unknown"}`,
		`Default repo: ${workspace.defaultRepo ?? config?.workspace?.defaultRepo ?? "unknown"}`,
		`Packet repo: ${workspace.taskPacketRepo ?? config?.workspace?.taskPacketRepo ?? "unknown"}`,
		`Strict routing: ${(workspace.strictRouting ?? config?.workspace?.strictRouting) ? "on" : "off"}`,
		`Workspace config: ${workspaceConfigExists(cwd) ? ".pi/taskplane-workspace.yaml" : "not found"}`,
		"Editable repos:",
		repos,
	].join("\n");
}

function buildStatusForRuntime(runtime: ActiveRuntime, cwd: string): string {
	return buildStatus(runtime.config, runtime.session, cwd);
}

function formatBool(value: boolean): string {
	return value ? "on" : "off";
}

function listTaskFolders(tasksRoot: string): string[] {
	if (!existsSync(tasksRoot)) return [];
	try {
		return readdirSync(tasksRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function buildWorkflows(runtime: ActiveRuntime): string {
	const config = runtime.config;
	if (!config) return "No Croc config found. Run `croc init` and `croc apply` before using workflow controls.";
	const workspace = runtime.session?.workspace;
	const tasksRoot =
		resolveMaybeRelative(runtime.runtimeRoot, workspace?.tasksRoot) ??
		join(runtime.runtimeRoot, config.taskplane.tasksPath);
	const taskFolders = listTaskFolders(tasksRoot);
	const lines = [
		"Croc workflows",
		`Profile: ${runtime.session?.profile ?? config.profile}`,
		`Runtime root: ${runtime.runtimeRoot}`,
		`Source root: ${runtime.sourceRoot}`,
		`Config: ${runtime.configPath ?? "unknown"}`,
		`Taskplane: ${config.taskplane.enabled ? "enabled" : "disabled"}`,
		`Task packets: ${workspace?.tasksPath ?? config.taskplane.tasksPath}`,
		`Dashboard: ${config.taskplane.dashboard.enabled ? getDashboardUrl(config) : "disabled"}`,
		`Integration: ${config.taskplane.integration}`,
		`Supervisor autonomy: ${config.taskplane.supervisorAutonomy}`,
		`Strict routing: ${formatBool(workspace?.strictRouting ?? config.workspace.strictRouting)}`,
		"",
		"Workflow controls:",
		"- /croc-status: show runtime and workspace context",
		"- /croc-workflows: list workflow settings and task packets",
		"- /croc-doctor: run Croc diagnostics",
		"- /croc-apply --confirm: rewrite generated runtime files after explicit confirmation",
		"- /croc-dashboard <start|stop|status>: control the Taskplane dashboard",
		"- /croc-config: show redacted active config",
	];
	lines.push("", "Task folders:");
	if (taskFolders.length === 0) lines.push("- none found");
	else lines.push(...taskFolders.map((name) => `- ${name}`));
	return lines.join("\n");
}

function formatDoctor(runtime: ActiveRuntime): string {
	if (!runtime.config || !runtime.configPath) {
		return "No Croc config found. Run `croc init` and `croc apply` before running doctor.";
	}
	return runDoctor(runtime.sourceRoot, runtime.config, runtime.configPath)
		.map((check) => `${check.status.padEnd(4)} ${check.name.padEnd(18)} ${redactSensitiveText(check.message)}`)
		.join("\n");
}

function parseDashboardAction(input: unknown): DashboardAction {
	if (input === "start" || input === "stop" || input === "status") return input;
	return "status";
}

function firstArg(args: string): string | undefined {
	return args.trim().split(/\s+/).filter(Boolean)[0];
}

function formatDashboardState(runtime: ActiveRuntime, action: DashboardAction): string {
	if (!runtime.config || !runtime.configPath) {
		return "No Croc config found. Run `croc init` and `croc apply` before using dashboard controls.";
	}
	const state =
		action === "start"
			? startDashboard(runtime.runtimeRoot, runtime.config, runtime.configPath)
			: action === "stop"
				? stopDashboard(runtime.runtimeRoot, runtime.config)
				: getDashboardState(runtime.runtimeRoot, runtime.config);
	const pid = state.pid ? ` ${state.pid}` : "";
	return [
		`Dashboard: ${state.status}${pid}`,
		`URL: ${getDashboardUrl(runtime.config)}`,
		`PID file: ${state.pidFile}`,
	].join("\n");
}

function parseConfirm(args: string): boolean {
	return args
		.trim()
		.split(/\s+/)
		.some((arg) => arg === "--confirm" || arg === "confirm" || arg === "confirmed");
}

function formatApply(runtime: ActiveRuntime, confirm: boolean): string {
	if (!confirm) {
		return "Croc apply rewrites generated runtime files. Ask the operator for confirmation, then call croc_apply({ confirm: true }) or run /croc-apply --confirm.";
	}
	if (!runtime.config || !runtime.configPath) {
		return "No Croc config found. Run `croc init` before applying Croc runtime files.";
	}
	const result = applyConfig(runtime.sourceRoot, runtime.config, runtime.configPath);
	const lines = [
		`Runtime root ${result.runtimeRoot}`,
		`Wrote ${result.taskplaneConfigPath}`,
		`Wrote ${result.piSettingsPath}`,
	];
	if (result.taskplanePreferencesPath) lines.push(`Wrote ${result.taskplanePreferencesPath}`);
	if (runtime.config.pi.provider.enabled) lines.push(`Enabled provider extension ${result.providerExtensionPath}`);
	if (result.workspaceFiles.length > 0) lines.push(`Wrote ${result.workspaceFiles.length} workspace file(s)`);
	if (result.createdRepos.length > 0) lines.push(`Prepared ${result.createdRepos.length} workspace repo(s)`);
	if (result.skills.manifestPath) lines.push(`Wrote ${result.skills.manifestPath}`);
	if (result.work.manifestPath) lines.push(`Wrote ${result.work.manifestPath}`);
	return lines.join("\n");
}

function shouldRedactKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (normalized.endsWith("env")) return false;
	return /apikey|secret|token|password|authorization|cookie|credential/.test(normalized);
}

function shouldRedactQueryParam(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		normalized === "key" ||
		normalized.endsWith("key") ||
		/api|secret|token|password|credential|auth|signature|sig/.test(normalized)
	);
}

function redactQueryParams(text: string): string {
	return text.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix: string, key: string) => {
		return shouldRedactQueryParam(key) ? `${prefix}${key}=[redacted]` : match;
	});
}

function redactSensitiveText(text: string): string {
	return redactQueryParams(text)
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi, "$1[redacted]@")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

function redactSecrets(value: unknown, key = ""): unknown {
	if (shouldRedactKey(key)) return typeof value === "string" && value.length > 0 ? "[redacted]" : value;
	if (typeof value === "string") return redactSensitiveText(value);
	if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
	if (!isRecord(value)) return value;
	const redacted: Record<string, unknown> = {};
	for (const [entryKey, entryValue] of Object.entries(value)) redacted[entryKey] = redactSecrets(entryValue, entryKey);
	return redacted;
}

function buildConfigOutput(runtime: ActiveRuntime): string {
	if (!runtime.config) return "No Croc config found. Run `croc init` before viewing config.";
	return [
		`Config: ${runtime.configPath ?? "unknown"}`,
		JSON.stringify(redactSecrets(runtime.config), null, "\t"),
	].join("\n");
}

function toolText(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text: redactSensitiveText(text) }], details: undefined };
}

function commandNotify(ctx: { ui: { notify(message: string, level?: string): void } }, text: string): void {
	ctx.ui.notify(redactSensitiveText(text), "info");
}

function toTextToolParams(value: unknown): TextToolParams {
	return isRecord(value) ? value : {};
}

function buildDynamicSystemPrompt(eventSystemPrompt: string, status: string): string {
	return [
		eventSystemPrompt.trimEnd(),
		"",
		"## Croc runtime context",
		"",
		status,
		"",
		"Croc context is read-only in this session. Do not mutate Croc config unless the user explicitly asks.",
	].join("\n");
}

function toModelConfig(model: CrocProviderModelConfig): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
	};
}

function toProviderConfig(provider: CrocProviderConfig): ProviderConfig {
	return {
		name: provider.displayName,
		baseUrl: provider.baseUrl,
		apiKey: `$${provider.apiKeyEnv}`,
		api: provider.api,
		authHeader: provider.authHeader,
		models: provider.models.map(toModelConfig),
	};
}

export default function (pi: ExtensionAPI) {
	const startupConfig = readConfig(process.env.CROC_CONFIG);
	const currentRuntime = (cwd: string) => resolveActiveRuntime(cwd, startupConfig);
	const provider = startupConfig?.pi.provider;
	if (provider?.enabled) {
		pi.registerProvider(provider.name, toProviderConfig(provider));
	}

	pi.registerCommand("croc-status", {
		description: "Show Croc workspace context",
		handler: async (_args, ctx) => {
			commandNotify(ctx, buildStatusForRuntime(currentRuntime(ctx.cwd), ctx.cwd));
		},
	});

	pi.registerCommand("croc-workflows", {
		description: "Show Croc workflow controls and task packet context",
		handler: async (_args, ctx) => {
			commandNotify(ctx, buildWorkflows(currentRuntime(ctx.cwd)));
		},
	});

	pi.registerCommand("croc-doctor", {
		description: "Run Croc diagnostics for the active workspace",
		handler: async (_args, ctx) => {
			commandNotify(ctx, formatDoctor(currentRuntime(ctx.cwd)));
		},
	});

	pi.registerCommand("croc-apply", {
		description: "Rewrite generated Croc runtime files after explicit confirmation",
		handler: async (args, ctx) => {
			commandNotify(ctx, formatApply(currentRuntime(ctx.cwd), parseConfirm(args)));
		},
	});

	pi.registerCommand("croc-dashboard", {
		description: "Control the Croc Taskplane dashboard",
		handler: async (args, ctx) => {
			commandNotify(ctx, formatDashboardState(currentRuntime(ctx.cwd), parseDashboardAction(firstArg(args))));
		},
	});

	pi.registerCommand("croc-config", {
		description: "Show the active Croc config with secrets redacted",
		handler: async (_args, ctx) => {
			commandNotify(ctx, buildConfigOutput(currentRuntime(ctx.cwd)));
		},
	});

	const registerTextTool = (definition: TextToolDefinition) => {
		pi.registerTool({
			name: definition.name,
			label: definition.label,
			description: definition.description,
			promptSnippet: definition.promptSnippet,
			promptGuidelines: definition.promptGuidelines,
			parameters: definition.parameters,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					return toolText(definition.execute(ctx, toTextToolParams(params)));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return toolText(`Error running ${definition.name}: ${message}`);
				}
			},
		});
	};

	registerTextTool({
		name: "croc_status",
		label: "Croc Status",
		description: "Show Croc runtime, workspace, source root, config path, and editable repo context.",
		promptSnippet: "croc_status() — show active Croc workspace context",
		promptGuidelines: [
			"Call croc_status before changing workflow state.",
			"Use the source root and config path from this output when explaining Croc context.",
		],
		parameters: emptyParameters,
		execute: (ctx) => buildStatusForRuntime(currentRuntime(ctx.cwd), ctx.cwd),
	});

	registerTextTool({
		name: "croc_workflows",
		label: "Croc Workflows",
		description: "Summarize Croc workflow controls, Taskplane settings, dashboard URL, and task packet folders.",
		promptSnippet: "croc_workflows() — list Croc workflow controls and packet context",
		promptGuidelines: [
			"Call croc_workflows when the operator asks what Croc can control from this session.",
			"Use this before starting or changing Taskplane work.",
		],
		parameters: emptyParameters,
		execute: (ctx) => buildWorkflows(currentRuntime(ctx.cwd)),
	});

	registerTextTool({
		name: "croc_doctor",
		label: "Croc Doctor",
		description: "Run Croc diagnostics for Node, Pi, Taskplane, workspace files, skills, and work bundles.",
		promptSnippet: "croc_doctor() — run Croc runtime diagnostics",
		promptGuidelines: [
			"Call croc_doctor when Croc or Taskplane setup looks broken.",
			"Report fail and warn checks before proposing changes.",
		],
		parameters: emptyParameters,
		execute: (ctx) => formatDoctor(currentRuntime(ctx.cwd)),
	});

	registerTextTool({
		name: "croc_apply",
		label: "Croc Apply",
		description: "Rewrite generated Croc runtime files. Requires confirm=true after explicit operator confirmation.",
		promptSnippet: "croc_apply(confirm?) — apply Croc config after confirmation",
		promptGuidelines: [
			"Never call croc_apply with confirm=true unless the operator explicitly confirms.",
			"Call croc_status first so the operator can see which runtime will be changed.",
		],
		parameters: applyParameters,
		execute: (ctx, params) => formatApply(currentRuntime(ctx.cwd), params.confirm === true),
	});

	registerTextTool({
		name: "croc_dashboard",
		label: "Croc Dashboard",
		description: "Start, stop, or check the Taskplane dashboard for the active Croc runtime.",
		promptSnippet: "croc_dashboard(action) — control dashboard start|stop|status",
		promptGuidelines: [
			"Use action='status' before starting or stopping unless the operator requested a specific action.",
			"Report the dashboard URL and pid state to the operator.",
		],
		parameters: dashboardParameters,
		execute: (ctx, params) => formatDashboardState(currentRuntime(ctx.cwd), parseDashboardAction(params.action)),
	});

	registerTextTool({
		name: "croc_config",
		label: "Croc Config",
		description: "Show the active Croc config with secret-looking values redacted.",
		promptSnippet: "croc_config() — show redacted active Croc config",
		promptGuidelines: [
			"Use croc_config when you need config details, but never reveal redacted secret values.",
			"Prefer croc_status for a shorter runtime summary.",
		],
		parameters: emptyParameters,
		execute: (ctx) => buildConfigOutput(currentRuntime(ctx.cwd)),
	});

	pi.on("session_start", async (_event, ctx) => {
		const runtime = currentRuntime(ctx.cwd);
		const session = runtime.session;
		const activeConfig = runtime.config;
		const profile = session?.profile ?? activeConfig?.profile;
		const repo = session?.workspace?.defaultRepo ?? activeConfig?.workspace.defaultRepo;
		if (profile) ctx.ui.setStatus("croc", repo ? `croc:${profile}:${repo}` : `croc:${profile}`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const runtime = currentRuntime(ctx.cwd);
		return {
			systemPrompt: buildDynamicSystemPrompt(event.systemPrompt, buildStatusForRuntime(runtime, ctx.cwd)),
		};
	});
}
