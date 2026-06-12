import { findConfigPath, loadConfig } from "./config.ts";
import { getBundledTaskplaneBinPath } from "./paths.ts";
import { spawnProcessSync } from "./process.ts";
import { resolveRuntimeContext } from "./workspace.ts";

export function resolveTaskplaneCliCwd(cwd: string, configPath?: string): string {
	if (!configPath && !findConfigPath(cwd)) return cwd;
	const loaded = loadConfig(cwd, configPath);
	return resolveRuntimeContext(cwd, loaded.config).root;
}

export function runTaskplaneCli(cwd: string, args: string[]): { stdout: string; stderr: string } {
	const result = spawnProcessSync("node", [getBundledTaskplaneBinPath(), ...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `taskplane ${args.join(" ")} failed`);
	}
	return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
