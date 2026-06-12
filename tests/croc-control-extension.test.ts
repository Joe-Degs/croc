import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import crocProviderExtension from "../src/extensions/provider.ts";

type CommandHandler = (args: string, ctx: CommandContext) => Promise<void> | void;

interface CommandContext {
	cwd: string;
	ui: {
		notify(message: string, level?: string): void;
	};
}

interface RegisteredCommand {
	description?: string;
	handler: CommandHandler;
}

interface RegisteredTool {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: unknown;
	parameters?: unknown;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: CommandContext,
	) => Promise<ToolResult> | ToolResult;
}

interface ToolResult {
	content?: Array<{ type: string; text?: string }>;
}

class FakePi {
	readonly commands = new Map<string, RegisteredCommand>();
	readonly tools = new Map<string, RegisteredTool>();
	readonly events: Array<{ name: string; handler: unknown }> = [];
	readonly providers = new Map<string, unknown>();

	registerCommand(name: string, command: RegisteredCommand): void {
		this.commands.set(name, command);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	on(name: string, handler: unknown): void {
		this.events.push({ name, handler });
	}

	registerProvider(name: string, provider: unknown): void {
		this.providers.set(name, provider);
	}
}

const expectedCommands = [
	"croc-status",
	"croc-workflows",
	"croc-doctor",
	"croc-apply",
	"croc-dashboard",
	"croc-config",
];

const expectedTools = ["croc_status", "croc_workflows", "croc_doctor", "croc_apply", "croc_dashboard", "croc_config"];

describe("Croc supervisor control extension", () => {
	let tempRoot: string;
	let oldCrocConfig: string | undefined;
	let oldApiKey: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "croc-control-extension-"));
		oldCrocConfig = process.env.CROC_CONFIG;
		oldApiKey = process.env.CROC_TEST_API_KEY;
		process.env.CROC_TEST_API_KEY = "super-secret-test-value";
	});

	afterEach(() => {
		if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });

		if (oldCrocConfig === undefined) delete process.env.CROC_CONFIG;
		else process.env.CROC_CONFIG = oldCrocConfig;

		if (oldApiKey === undefined) delete process.env.CROC_TEST_API_KEY;
		else process.env.CROC_TEST_API_KEY = oldApiKey;
	});

	it("registers the supervisor slash commands", () => {
		const pi = activateExtension();

		for (const commandName of expectedCommands) {
			assert.ok(pi.commands.has(commandName), `${commandName} should be registered`);
		}
	});

	it("registers the supervisor tools", () => {
		const pi = activateExtension();

		for (const toolName of expectedTools) {
			assert.ok(pi.tools.has(toolName), `${toolName} should be registered`);
		}
	});

	it("does not register model providers by default", () => {
		delete process.env.CROC_CONFIG;

		const pi = activateExtension();

		assert.equal(pi.providers.size, 0);
	});

	it("registers multiple inline Pi model providers", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				pi: {
					models: {
						providers: {
							alpha: {
								baseUrl: "https://alpha.example.invalid/v1",
								api: "openai-completions",
								apiKey: "$ALPHA_API_KEY",
								models: [{ id: "alpha-chat" }],
							},
							beta: {
								baseUrl: "https://beta.example.invalid/v1",
								api: "anthropic-messages",
								apiKey: "$BETA_API_KEY",
								models: [{ id: "beta-chat" }],
							},
						},
					},
				},
			}),
			"utf-8",
		);
		process.env.CROC_CONFIG = configPath;

		const pi = activateExtension();

		assert.deepEqual([...pi.providers.keys()].sort(), ["alpha", "beta"]);
		assert.equal(providerRecord(pi, "alpha").apiKey, "$ALPHA_API_KEY");
		assert.equal(providerRecord(pi, "beta").api, "anthropic-messages");
	});

	it("loads Pi models file providers and lets inline providers override them", () => {
		const configDir = join(tempRoot, "project");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "models.json"),
			JSON.stringify({
				providers: {
					"file-only": {
						baseUrl: "https://file-only.example.invalid/v1",
						api: "openai-completions",
						apiKey: "$FILE_ONLY_API_KEY",
						models: [{ id: "file-chat" }],
					},
					shared: {
						baseUrl: "https://file-shared.example.invalid/v1",
						api: "openai-completions",
						apiKey: "$FILE_SHARED_API_KEY",
						models: [{ id: "file-shared-chat" }],
					},
				},
			}),
			"utf-8",
		);
		const configPath = join(configDir, "croc.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				pi: {
					models: {
						file: "models.json",
						providers: {
							shared: {
								baseUrl: "https://inline-shared.example.invalid/v1",
								api: "openai-responses",
								apiKey: "$INLINE_SHARED_API_KEY",
								models: [{ id: "inline-shared-chat" }],
							},
						},
					},
				},
			}),
			"utf-8",
		);
		process.env.CROC_CONFIG = configPath;

		const pi = activateExtension();

		assert.deepEqual([...pi.providers.keys()].sort(), ["file-only", "shared"]);
		assert.equal(providerRecord(pi, "file-only").apiKey, "$FILE_ONLY_API_KEY");
		assert.equal(providerRecord(pi, "shared").apiKey, "$INLINE_SHARED_API_KEY");
		assert.equal(providerRecord(pi, "shared").baseUrl, "https://inline-shared.example.invalid/v1");
	});

	it("fails clearly when a configured Pi models file is missing", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(configPath, JSON.stringify({ pi: { models: { file: "missing-models.json" } } }), "utf-8");
		process.env.CROC_CONFIG = configPath;

		assert.throws(() => activateExtension(), /Configured Pi models file not found: .*missing-models\.json/);
	});

	it("registers Headroom-routed global Pi providers as baseUrl-only overrides", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				batteries: {
					headroom: {
						enabled: true,
						proxy: {
							mode: "external",
							url: "http://127.0.0.1:18787/",
						},
						routing: {
							providers: {
								openai: { target: "openai" },
							},
						},
					},
				},
			}),
			"utf-8",
		);
		process.env.CROC_CONFIG = configPath;

		const pi = activateExtension();

		assert.deepEqual([...pi.providers.keys()], ["openai"]);
		assert.deepEqual(providerRecord(pi, "openai"), { baseUrl: "http://127.0.0.1:18787/v1" });
	});

	it("does not register headroom_retrieve when CCR mode is disabled", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(configPath, JSON.stringify(headroomConfig("disabled", "https://headroom.example.test")), "utf-8");
		process.env.CROC_CONFIG = configPath;

		const pi = activateExtension();

		assert.equal(pi.tools.has("headroom_retrieve"), false);
	});

	it("registers exactly one bridge tool when CCR mode is bridge", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(configPath, JSON.stringify(headroomConfig("bridge")), "utf-8");
		process.env.CROC_CONFIG = configPath;

		const pi = activateExtension();
		const tool = pi.tools.get("headroom_retrieve");

		assert.equal([...pi.tools.keys()].filter((name) => name === "headroom_retrieve").length, 1);
		assert.ok(tool);
		assert.equal(tool.name, "headroom_retrieve");
		assert.equal(tool.label, "Headroom Retrieve");
		assert.equal(
			tool.description,
			"Retrieve original content for a Headroom CCR hash from the configured local proxy.",
		);
		assert.deepEqual(tool.parameters, {
			type: "object",
			properties: {
				hash: {
					type: "string",
					pattern: "^[a-fA-F0-9]{24}$",
				},
				query: {
					type: "string",
					maxLength: 1000,
				},
			},
			required: ["hash"],
			additionalProperties: false,
		});
	});

	it("does not duplicate the bridge tool across repeated activation in the fake harness", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(configPath, JSON.stringify(headroomConfig("bridge")), "utf-8");
		process.env.CROC_CONFIG = configPath;
		const pi = new FakePi();

		crocProviderExtension(pi as never);
		crocProviderExtension(pi as never);

		assert.equal([...pi.tools.keys()].filter((name) => name === "headroom_retrieve").length, 1);
		assert.equal(pi.tools.size, expectedTools.length + 1);
	});

	it("fails activation for untrusted non-local Headroom bridge origins", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(configPath, JSON.stringify(headroomConfig("bridge", "https://headroom.example.test")), "utf-8");
		process.env.CROC_CONFIG = configPath;

		assert.throws(() => activateExtension(), /origin is not trusted/);
	});

	it("fails clearly when extension activation sees an unsupported Headroom target", () => {
		const configPath = join(tempRoot, "croc.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				batteries: {
					headroom: {
						enabled: true,
						proxy: {
							mode: "external",
							url: "http://127.0.0.1:18787/",
						},
						routing: {
							providers: {
								gemini: { target: "gemini" },
							},
						},
					},
				},
			}),
			"utf-8",
		);
		process.env.CROC_CONFIG = configPath;

		assert.throws(() => activateExtension(), /Headroom target "gemini" is not supported in v1/);
	});

	it("registers complete tool metadata and returns text for safe tool calls", async () => {
		const { projectRoot } = writeCrocWorkspace();
		const pi = activateExtension();

		for (const toolName of expectedTools) {
			const tool = pi.tools.get(toolName);
			assert.ok(tool, `${toolName} should be registered`);
			const description = tool.description;
			const promptSnippet = tool.promptSnippet;
			if (typeof description !== "string") assert.fail(`${toolName} should have a description`);
			assert.notEqual(description.trim(), "", `${toolName} should have a non-empty description`);
			if (typeof promptSnippet !== "string") assert.fail(`${toolName} should have a prompt snippet`);
			assert.notEqual(promptSnippet.trim(), "", `${toolName} should have a non-empty prompt snippet`);
			assert.ok(tool.promptGuidelines, `${toolName} should have prompt guidelines`);
			assert.ok(tool.parameters, `${toolName} should have parameters`);
			assert.equal(typeof tool.execute, "function", `${toolName} should have an execute function`);
		}

		const safeCalls: Array<[string, Record<string, unknown>]> = [
			["croc_status", {}],
			["croc_workflows", {}],
			["croc_doctor", {}],
			["croc_dashboard", { action: "status" }],
			["croc_config", {}],
		];
		for (const [toolName, params] of safeCalls) {
			assertToolText(await executeTool(pi, toolName, params, projectRoot), `${toolName} should return text content`);
		}

		const applyWithoutConfirmation = toolText(await executeTool(pi, "croc_apply", {}, projectRoot));
		assert.match(applyWithoutConfirmation, /confirm/i);
		assert.doesNotMatch(applyWithoutConfirmation, /super-secret-test-value/);
	});

	it("keeps the current croc-status command working", async () => {
		const { projectRoot, sessionConfigPath, sourceRoot } = writeCrocWorkspace();
		const pi = activateExtension();
		const notifications = await executeCommand(pi, "croc-status", projectRoot);

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "info");
		assert.match(notifications[0]?.message ?? "", /Croc profile: test-profile/);
		assert.match(notifications[0]?.message ?? "", /Workspace mode: off|Editable repos:/);
		assert.ok(notifications[0]?.message.includes(sessionConfigPath));
		assert.ok(notifications[0]?.message.includes(sourceRoot));
	});

	it("redacts API key values from config command and tool output", async () => {
		const { projectRoot } = writeCrocWorkspace();
		const pi = activateExtension();

		const notifications = await executeCommand(pi, "croc-config", projectRoot);
		const commandOutput = notifications.map((notification) => notification.message).join("\n");
		assert.doesNotMatch(commandOutput, /super-secret-test-value/);

		const toolResult = await executeTool(pi, "croc_config", {}, projectRoot);
		const toolOutput = toolText(toolResult);
		assert.notEqual(toolOutput, "");
		assert.doesNotMatch(toolOutput, /super-secret-test-value/);

		const doctorOutput = toolText(await executeTool(pi, "croc_doctor", {}, projectRoot));
		assert.doesNotMatch(doctorOutput, /super-secret-test-value/);
	});

	it("redacts API key values from CLI config output", () => {
		const { sessionConfigPath } = writeCrocWorkspace();

		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", "src/cli.ts", "config", "--config", sessionConfigPath],
			{ cwd: process.cwd(), encoding: "utf-8" },
		);

		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /super-secret-test-value/);
		assert.match(result.stdout, /"apiKey": "\[redacted\]"/);
		assert.match(result.stdout, /"authorization": "\[redacted\]"/);
	});

	it("resolves workflow status sourceRoot and configPath from .croc/session.json", async () => {
		const { projectRoot, sessionConfigPath, sourceRoot } = writeCrocWorkspace();
		const pi = activateExtension();

		const notifications = await executeCommand(pi, "croc-status", projectRoot);
		const commandOutput = notifications.map((notification) => notification.message).join("\n");
		assert.ok(commandOutput.includes(`Config: ${sessionConfigPath}`));
		assert.ok(commandOutput.includes(`Source root: ${sourceRoot}`));

		const toolOutput = toolText(await executeTool(pi, "croc_status", {}, projectRoot));
		assert.ok(toolOutput.includes(`Config: ${sessionConfigPath}`));
		assert.ok(toolOutput.includes(`Source root: ${sourceRoot}`));
	});

	function activateExtension(pi = new FakePi()): FakePi {
		crocProviderExtension(pi as never);
		return pi;
	}

	function writeCrocWorkspace(): { projectRoot: string; sessionConfigPath: string; sourceRoot: string } {
		const projectRoot = join(tempRoot, "project");
		const sourceRoot = join(tempRoot, "source-root");
		const envConfigPath = join(tempRoot, "env-croc-config.json");
		const sessionConfigPath = join(tempRoot, "session-croc-config.json");
		mkdirSync(join(projectRoot, ".croc"), { recursive: true });
		mkdirSync(sourceRoot, { recursive: true });
		writeFileSync(envConfigPath, JSON.stringify(crocConfig("env-profile")), "utf-8");
		writeFileSync(sessionConfigPath, JSON.stringify(crocConfig("test-profile")), "utf-8");
		writeFileSync(
			join(projectRoot, ".croc", "session.json"),
			JSON.stringify({
				profile: "test-profile",
				configPath: sessionConfigPath,
				sourceRoot,
				workspace: {
					root: projectRoot,
					tasksPath: "packets/tasks",
					defaultRepo: "app",
					taskPacketRepo: "packets",
					strictRouting: true,
					repos: [{ id: "app", mode: "edit", path: sourceRoot }],
				},
			}),
			"utf-8",
		);
		process.env.CROC_CONFIG = envConfigPath;

		return { projectRoot, sessionConfigPath, sourceRoot };
	}
});

function headroomConfig(mode: "disabled" | "bridge", url = "http://127.0.0.1:18787/"): Record<string, unknown> {
	return {
		batteries: {
			headroom: {
				enabled: true,
				proxy: {
					mode: "external",
					url,
				},
				routing: {
					providers: {
						openai: { target: "openai" },
					},
				},
				ccr: {
					mode,
					timeoutSeconds: 1,
					maxResultBytes: 4096,
					trustedOrigins: [],
				},
			},
		},
	};
}

function crocConfig(profile: string): Record<string, unknown> {
	return {
		profile,
		workspace: {
			enabled: true,
			defaultRepo: "app",
			taskPacketRepo: "packets",
			strictRouting: true,
		},
		taskplane: {
			tasksPath: "packets/tasks",
		},
		pi: {
			models: {
				providers: {
					"test-provider": {
						name: "Test Provider",
						baseUrl: "https://token@example.invalid/v1?key=super-secret-test-value",
						api: "openai-responses",
						apiKey: "super-secret-test-value",
						headers: {
							authorization: "Bearer super-secret-test-value",
							"x-api-key": "super-secret-test-value",
						},
						authHeader: true,
						models: [],
					},
				},
			},
		},
		batteries: {
			webSearch: {
				enabled: true,
				url: "https://search.example.invalid/?api_key=super-secret-test-value",
			},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerRecord(pi: FakePi, name: string): Record<string, unknown> {
	const provider = pi.providers.get(name);
	assert.ok(isRecord(provider), `${name} provider should be an object`);
	return provider;
}

async function executeCommand(
	pi: FakePi,
	name: string,
	cwd: string,
): Promise<Array<{ message: string; level?: string }>> {
	const command = pi.commands.get(name);
	assert.ok(command, `${name} should be registered`);
	const notifications: Array<{ message: string; level?: string }> = [];
	await command.handler("", {
		cwd,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});
	return notifications;
}

async function executeTool(
	pi: FakePi,
	name: string,
	params: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const tool = pi.tools.get(name);
	assert.ok(tool, `${name} should be registered`);
	const execute = tool.execute;
	if (typeof execute !== "function") assert.fail(`${name} should have an execute function`);
	return await execute("test-tool-call", params, new AbortController().signal, () => {}, {
		cwd,
		ui: {
			notify() {},
		},
	});
}

function assertToolText(result: ToolResult, message: string): void {
	assert.notEqual(toolText(result), "", message);
}

function toolText(result: ToolResult): string {
	return (
		result.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.join("\n") ?? ""
	);
}
