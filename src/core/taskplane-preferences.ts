import { join } from "node:path";
import type { CrocConfig } from "./config.ts";
import { getAgentDir, readJsonObject, writeJson } from "./config.ts";

export function getTaskplanePreferencesPath(): string {
	return join(getAgentDir(), "taskplane", "preferences.json");
}

export function writeTaskplanePreferences(config: CrocConfig): string | undefined {
	if (!config.taskplane.dashboard.enabled || !config.taskplane.dashboard.applyGlobalPreference) {
		return undefined;
	}
	const path = getTaskplanePreferencesPath();
	const preferences = readJsonObject(path);
	preferences.dashboardPort = config.taskplane.dashboard.port;
	writeJson(path, preferences);
	return path;
}
