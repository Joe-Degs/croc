import {
	type CrocCommandName,
	type TaskplaneCommandName,
	isCrocCommandName,
	isTaskplaneCommandName,
	printHelp,
} from "./commands.ts";

export { printHelp };

export type Command = CrocCommandName | "help";
export type DashboardAction = "start" | "stop" | "status";
export type ConfigAction = "show";
export type TaskplaneAction = TaskplaneCommandName;

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
	helpPath?: string[];
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
			if (arg === "--help" || arg === "-h") {
				help = true;
				continue;
			}
			if (arg === "--no-tmux") {
				disableTmux = true;
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

	const command = toCommand(positionals[0], help);
	const helpRequested = help || command === "help" || (command === "taskplane" && positionals[1] === "help");
	const args: Args = {
		command,
		cwd,
		force,
		disableTmux,
		help: helpRequested,
		diagnostics,
	};
	if (configPath) args.configPath = configPath;
	if (helpRequested) args.helpPath = resolveHelpPath(positionals, command);

	if (command === "dashboard") {
		const action = positionals[1];
		args.dashboardAction = action === "start" || action === "stop" || action === "status" ? action : "status";
	} else if (command === "taskplane") {
		const action = positionals[1];
		if (!action) {
			args.taskplaneArgs = ["status"];
		} else if (action === "help") {
			const topic = positionals[2];
			if (topic && !isTaskplaneCommandName(topic)) {
				diagnostics.push({ type: "error", message: `Unknown taskplane action: ${topic}` });
				args.taskplaneAction = "status";
				args.taskplaneArgs = ["status"];
			} else {
				args.taskplaneArgs = positionals.slice(1);
			}
		} else if (isTaskplaneCommandName(action)) {
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
	if (isCrocCommandName(value)) {
		return value;
	}
	return value ? "help" : "help";
}

function resolveHelpPath(positionals: string[], command: Command): string[] {
	if (positionals[0] === "help") {
		return positionals.slice(1, 3);
	}
	if (positionals[0] === "taskplane" && positionals[1] === "help") {
		const action = positionals[2];
		return isTaskplaneCommandName(action) ? ["taskplane", action] : ["taskplane"];
	}
	if (command === "help") return [];
	if (command === "taskplane") {
		const action = positionals[1];
		return isTaskplaneCommandName(action) ? [command, action] : [command];
	}
	return [command];
}
