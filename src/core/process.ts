import {
	type ChildProcess,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import crossSpawn from "cross-spawn";

export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): CommandResult {
	const result =
		process.platform === "win32" ? crossSpawn.sync(command, args, options) : nodeSpawnSync(command, args, options);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		...(result.error ? { error: result.error } : {}),
	};
}

export function commandExists(command: string): boolean {
	const result =
		process.platform === "win32"
			? spawnProcessSync("where", [command], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
			: spawnProcessSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				});
	return result.status === 0;
}

export function commandOutput(command: string, args: string[]): CommandResult {
	return spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildShellCommand(env: Record<string, string | undefined>, command: string, args: string[]): string {
	const exports = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `export ${key}=${shellQuote(value)}`);
	return [...exports, [command, ...args].map(shellQuote).join(" ")].join(" && ");
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
}
