export type CrocCommandName =
	| "init"
	| "apply"
	| "doctor"
	| "start"
	| "attach"
	| "dashboard"
	| "taskplane"
	| "config"
	| "version";

export type TaskplaneCommandName =
	| "status"
	| "summary"
	| "integrate"
	| "history"
	| "mailbox"
	| "replies"
	| "tell"
	| "broadcast"
	| "start"
	| "pause"
	| "resume"
	| "abort";

export interface CliOptionHelp {
	flags: string;
	description: string;
}

export interface CliCommandHelp<Name extends string = string> {
	name: Name;
	summary: string;
	usage: readonly string[];
	options?: readonly CliOptionHelp[];
	examples?: readonly string[];
	children?: readonly CliCommandHelp[];
	delegatesTaskplaneHelp?: boolean;
}

const GLOBAL_OPTIONS: readonly CliOptionHelp[] = [
	{ flags: "--config <path>", description: "Use a specific croc.yaml, croc.yml, or croc.json path" },
	{ flags: "--cwd <path>", description: "Run against a specific project directory" },
	{ flags: "--force", description: "Overwrite files where supported" },
	{ flags: "--no-tmux", description: "Start Pi directly even if tmux is enabled" },
	{ flags: "--help, -h", description: "Show help" },
	{ flags: "--version, -v", description: "Show version" },
];

export const TASKPLANE_COMMANDS: readonly CliCommandHelp<TaskplaneCommandName>[] = [
	{
		name: "status",
		summary: "Show current persisted batch status",
		usage: ["croc taskplane status [--config <path>]"],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "summary",
		summary: "Show latest persisted batch summary",
		usage: ["croc taskplane summary [--config <path>]"],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "integrate",
		summary: "Integrate a completed batch into the working branch",
		usage: ["croc taskplane integrate [--ff|--merge|--pr] [--config <path>]"],
		options: [
			{ flags: "--ff, --fast-forward", description: "Fast-forward only" },
			{ flags: "--merge", description: "Create a merge commit" },
			{ flags: "--pr", description: "Create a pull request" },
		],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "history",
		summary: "Show persisted batch history and details",
		usage: [
			"croc taskplane history [--limit <n>] [--json]",
			"croc taskplane history --batch <id|latest> [--agents] [--events]",
		],
		options: [
			{ flags: "--limit <n>", description: "Limit compact history output" },
			{ flags: "--json", description: "Print JSON output" },
			{ flags: "--batch <id|latest>", description: "Show a specific batch" },
			{ flags: "--agents", description: "Include runtime agent snapshots with --batch" },
			{ flags: "--events", description: "Include lifecycle events with --batch" },
		],
		examples: ["croc taskplane history", "croc taskplane history --batch latest --agents"],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "mailbox",
		summary: "Inspect persisted agent mailbox state",
		usage: ["croc taskplane mailbox [<id|latest>] [--agent <id>] [--pending] [--json]"],
		options: [
			{ flags: "--agent <id>", description: "Show one agent mailbox" },
			{ flags: "--pending", description: "Only show pending messages" },
			{ flags: "--json", description: "Print JSON output" },
		],
		examples: ["croc taskplane mailbox latest", "croc taskplane mailbox latest --agent croc-user-lane-1-worker"],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "replies",
		summary: "Show agent reply and escalation history",
		usage: ["croc taskplane replies [--batch <id|latest>] [--agent <id>]"],
		options: [
			{ flags: "--batch <id|latest>", description: "Read replies from a specific batch" },
			{ flags: "--agent <id>", description: "Show one agent's replies" },
		],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "tell",
		summary: "Send a mailbox message to one active agent",
		usage: ["croc taskplane tell <agentId> <text>"],
		examples: ['croc taskplane tell croc-user-lane-1-worker "wrap up and report status"'],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "broadcast",
		summary: "Send a mailbox message to all active agents",
		usage: ["croc taskplane broadcast <text>"],
		examples: ['croc taskplane broadcast "pause new work and report status"'],
		delegatesTaskplaneHelp: true,
	},
	{
		name: "start",
		summary: "Start a targeted Taskplane batch through Croc's normal launch path",
		usage: ["croc taskplane start <target> [--config <path>] [--no-tmux]"],
		examples: ["croc taskplane start all", "croc taskplane start TASK-004"],
	},
	{
		name: "pause",
		summary: "Dispatch /orch-pause to the running Croc Pi session",
		usage: ["croc taskplane pause [--config <path>]"],
	},
	{
		name: "resume",
		summary: "Dispatch /orch-resume to the running Croc Pi session",
		usage: ["croc taskplane resume [--force] [--config <path>]"],
		options: [{ flags: "--force", description: "Resume even when Taskplane would normally require confirmation" }],
	},
	{
		name: "abort",
		summary: "Dispatch /orch-abort to the running Croc Pi session",
		usage: ["croc taskplane abort [--hard] [--config <path>]"],
		options: [{ flags: "--hard", description: "Request a hard abort" }],
	},
];

export const CROC_COMMANDS: readonly CliCommandHelp<CrocCommandName>[] = [
	{
		name: "init",
		summary: "Write a starter Croc config",
		usage: ["croc init [--force] [--config <path>]"],
		options: [
			{ flags: "--force", description: "Overwrite an existing config file" },
			{ flags: "--config <path>", description: "Write config to a specific path" },
		],
		examples: ["croc init", "croc init --force"],
	},
	{
		name: "apply",
		summary: "Materialize runtime workspace, Taskplane config, Pi settings, work files, and skills",
		usage: ["croc apply [--config <path>]"],
		examples: ["croc apply"],
	},
	{
		name: "doctor",
		summary: "Check config and runtime prerequisites",
		usage: ["croc doctor [--config <path>]"],
		examples: ["croc doctor"],
	},
	{
		name: "start",
		summary: "Apply config, start configured services, and launch Pi with an optional Taskplane target",
		usage: ["croc start [target] [--config <path>] [--no-tmux]"],
		options: [
			{ flags: "target", description: "Taskplane target such as all, an area name, a task ID, or a PROMPT.md path" },
			{ flags: "--no-tmux", description: "Start Pi directly even if tmux is enabled" },
		],
		examples: ["croc start", "croc start all", "croc start TASK-004"],
	},
	{
		name: "attach",
		summary: "Attach to the configured tmux session",
		usage: ["croc attach [--config <path>]"],
	},
	{
		name: "dashboard",
		summary: "Manage the bundled Taskplane dashboard",
		usage: ["croc dashboard <start|stop|status> [--config <path>]"],
		examples: ["croc dashboard start", "croc dashboard status"],
	},
	{
		name: "taskplane",
		summary: "Inspect and control the bundled Taskplane runtime",
		usage: ["croc taskplane <command> [options] [--config <path>]"],
		children: TASKPLANE_COMMANDS,
		examples: ["croc taskplane status", "croc taskplane history --batch latest", "croc taskplane pause"],
	},
	{
		name: "config",
		summary: "Print the loaded Croc config with secrets redacted",
		usage: ["croc config show [--config <path>]"],
	},
	{
		name: "version",
		summary: "Show Croc version",
		usage: ["croc --version", "croc version"],
	},
];

function rowLines(rows: readonly CliOptionHelp[]): string[] {
	if (rows.length === 0) return [];
	const width = rows.reduce((max, row) => Math.max(max, row.flags.length), 0);
	return rows.map((row) => `  ${row.flags.padEnd(width)}  ${row.description}`);
}

function commandRows(commands: readonly CliCommandHelp[]): CliOptionHelp[] {
	return commands.map((command) => ({ flags: command.name, description: command.summary }));
}

function appendSection(lines: string[], title: string, body: readonly string[]): void {
	if (body.length === 0) return;
	lines.push("", `${title}:`, ...body);
}

function findChild(command: CliCommandHelp, name: string): CliCommandHelp | undefined {
	return command.children?.find((child) => child.name === name);
}

export function findCommandHelp(path: readonly string[]): CliCommandHelp | undefined {
	if (path.length === 0) return undefined;
	const [first, ...rest] = path;
	let command: CliCommandHelp | undefined = CROC_COMMANDS.find((entry) => entry.name === first);
	for (const segment of rest) {
		if (!command) return undefined;
		command = findChild(command, segment);
	}
	return command;
}

export function formatHelp(path: readonly string[] = []): string {
	const command = findCommandHelp(path);
	if (command) return formatCommandHelp(path, command);
	return formatRootHelp();
}

function formatRootHelp(): string {
	const lines = ["croc - Taskplane launcher and profile manager for Pi", "", "Usage:", "  croc <command> [options]"];
	appendSection(lines, "Commands", rowLines(commandRows(CROC_COMMANDS)));
	appendSection(lines, "Taskplane commands", rowLines(commandRows(TASKPLANE_COMMANDS)));
	appendSection(lines, "Global options", rowLines(GLOBAL_OPTIONS));
	appendSection(lines, "Examples", [
		"  croc init",
		"  croc apply",
		"  croc start all",
		"  croc dashboard start",
		"  croc taskplane status",
	]);
	return `${lines.join("\n")}\n`;
}

function formatCommandHelp(path: readonly string[], command: CliCommandHelp): string {
	const qualifiedName = ["croc", ...path].join(" ");
	const lines = [`${qualifiedName} - ${command.summary}`, "", "Usage:", ...command.usage.map((entry) => `  ${entry}`)];
	appendSection(lines, "Commands", rowLines(commandRows(command.children ?? [])));
	appendSection(lines, "Options", rowLines(command.options ?? []));
	appendSection(lines, "Examples", command.examples?.map((example) => `  ${example}`) ?? []);
	return `${lines.join("\n")}\n`;
}

export function printHelp(path: readonly string[] = []): void {
	console.log(formatHelp(path));
}

export function isCrocCommandName(value: string | undefined): value is CrocCommandName {
	return value !== undefined && CROC_COMMANDS.some((command) => command.name === value);
}

export function isTaskplaneCommandName(value: string | undefined): value is TaskplaneCommandName {
	return value !== undefined && TASKPLANE_COMMANDS.some((command) => command.name === value);
}

export function shouldDelegateTaskplaneHelp(action: TaskplaneCommandName): boolean {
	return findCommandHelp(["taskplane", action])?.delegatesTaskplaneHelp === true;
}
