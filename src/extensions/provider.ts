import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

type ApiName = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generate-content";

interface CrocProviderModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

interface CrocProviderConfig {
	enabled: boolean;
	name: string;
	displayName: string;
	baseUrl: string;
	api: ApiName;
	apiKeyEnv: string;
	authHeader: boolean;
	models: CrocProviderModelConfig[];
}

interface CrocConfig {
	profile?: string;
	workspace?: {
		enabled?: boolean;
		defaultRepo?: string;
		taskPacketRepo?: string;
		strictRouting?: boolean;
	};
	taskplane?: {
		tasksPath?: string;
	};
	pi?: {
		name?: string;
		provider?: CrocProviderConfig;
	};
}

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
		tasksPath?: string;
		defaultRepo?: string;
		taskPacketRepo?: string;
		strictRouting?: boolean;
		repos?: CrocSessionRepo[];
	};
}

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
		return isRecord(parsed) ? (parsed as CrocConfig) : undefined;
	} catch {
		return undefined;
	}
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
	const config = readConfig(process.env.CROC_CONFIG);
	const currentConfig = () => readConfig(process.env.CROC_CONFIG) ?? config;
	const provider = config?.pi?.provider;
	if (provider?.enabled) {
		pi.registerProvider(provider.name, toProviderConfig(provider));
	}

	pi.registerCommand("croc-status", {
		description: "Show Croc workspace context",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildStatus(currentConfig(), readSession(ctx.cwd), ctx.cwd), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const session = readSession(ctx.cwd);
		const activeConfig = currentConfig();
		const profile = session?.profile ?? activeConfig?.profile;
		const repo = session?.workspace?.defaultRepo ?? activeConfig?.workspace?.defaultRepo;
		if (profile) ctx.ui.setStatus("croc", repo ? `croc:${profile}:${repo}` : `croc:${profile}`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		return {
			systemPrompt: buildDynamicSystemPrompt(
				event.systemPrompt,
				buildStatus(currentConfig(), readSession(ctx.cwd), ctx.cwd),
			),
		};
	});
}
