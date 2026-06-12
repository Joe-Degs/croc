export type Command =
	| "init"
	| "apply"
	| "doctor"
	| "start"
	| "attach"
	| "dashboard"
	| "taskplane"
	| "config"
	| "help"
	| "version";
export type DashboardAction = "start" | "stop" | "status";
export type ConfigAction = "show";
export type TaskplaneAction = "status" | "summary" | "integrate";

export interface Args {
	command: Command;
	configPath?: string;
	cwd: string;
	force: boolean;
	disableTmux: boolean;
	target?: string;
	dashboardAction?: DashboardAction;
	configAction?: ConfigAction;
	taskplaneAction?: TaskplaneAction;
	taskplaneArgs?: string[];
	help: boolean;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

function readValue(args: string[], index: number, flag: string, diagnostics: Args["diagnostics"]): string | undefined {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		diagnostics.push({ type: "error", message: `${flag} requires a value` });
		return undefined;
	}
	return value;
}

export function parseArgs(rawArgs: string[]): Args {
	const diagnostics: Args["diagnostics"] = [];
	const positionals: string[] = [];
	let configPath: string | undefined;
	let cwd = process.cwd();
	let force = false;
	let disableTmux = false;
	let help = false;
	let delegatingTaskplane = false;

	for (let index = 0; index < rawArgs.length; index++) {
		const arg = rawArgs[index];
		if (delegatingTaskplane) {
			if (arg === "--config") {
				const value = readValue(rawArgs, index, arg, diagnostics);
				if (value) {
					configPath = value;
					index++;
				}
				continue;
			}
			if (arg === "--cwd") {
				const value = readValue(rawArgs, index, arg, diagnostics);
				if (value) {
					cwd = value;
					index++;
				}
				continue;
			}
			positionals.push(arg);
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--version" || arg === "-v") {
			positionals.push("version");
			continue;
		}
		if (arg === "--config") {
			const value = readValue(rawArgs, index, arg, diagnostics);
			if (value) {
				configPath = value;
				index++;
			}
			continue;
		}
		if (arg === "--cwd") {
			const value = readValue(rawArgs, index, arg, diagnostics);
			if (value) {
				cwd = value;
				index++;
			}
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--no-tmux") {
			disableTmux = true;
			continue;
		}
		if (arg.startsWith("-")) {
			diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
			continue;
		}
		positionals.push(arg);
		if (arg === "taskplane") delegatingTaskplane = true;
	}

	const first = positionals[0];
	const command = toCommand(first, help);
	const args: Args = {
		command,
		cwd,
		force,
		disableTmux,
		help,
		diagnostics,
	};
	if (configPath) args.configPath = configPath;

	if (command === "dashboard") {
		const action = positionals[1];
		args.dashboardAction = action === "start" || action === "stop" || action === "status" ? action : "status";
	} else if (command === "taskplane") {
		const action = positionals[1] || "status";
		if (action === "status" || action === "summary" || action === "integrate") {
			args.taskplaneAction = action;
			args.taskplaneArgs = positionals.slice(1).length > 0 ? positionals.slice(1) : ["status"];
		} else {
			diagnostics.push({ type: "error", message: `Unknown taskplane action: ${action}` });
			args.taskplaneAction = "status";
			args.taskplaneArgs = ["status"];
		}
	} else if (command === "config") {
		args.configAction = "show";
	} else if (command === "start") {
		args.target = positionals.slice(1).join(" ") || undefined;
	}

	return args;
}

function toCommand(value: string | undefined, help: boolean): Command {
	if (help && !value) return "help";
	if (
		value === "init" ||
		value === "apply" ||
		value === "doctor" ||
		value === "start" ||
		value === "attach" ||
		value === "dashboard" ||
		value === "taskplane" ||
		value === "config" ||
		value === "version"
	) {
		return value;
	}
	return value ? "help" : "help";
}

export function printHelp(): void {
	console.log(`croc - Taskplane launcher and profile manager for Pi

Usage:
  croc init [--force] [--config <path>]
  croc apply [--config <path>]
  croc doctor [--config <path>]
  croc start [target] [--config <path>] [--no-tmux]
  croc attach [--config <path>]
  croc dashboard <start|stop|status> [--config <path>]
  croc taskplane <status|summary|integrate> [--config <path>]
  croc config show [--config <path>]

Options:
  --config <path>  Use a specific croc.yaml, croc.yml, or croc.json path
  --cwd <path>     Run against a specific project directory
  --force          Overwrite files where supported
  --no-tmux        Start Pi directly even if tmux is enabled
  --help, -h       Show this help
  --version, -v    Show version

Examples:
  croc init
  croc apply
  croc start all
  croc dashboard start
  croc taskplane status
`);
}
