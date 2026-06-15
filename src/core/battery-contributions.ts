import type { CrocConfig } from "./config.ts";
import { shouldRegisterHeadroomBridge } from "./headroom-bridge.ts";

const WEB_SEARCH_TOOLS = ["web_search", "web_fetch"];
const HEADROOM_BRIDGE_TOOLS = ["headroom_retrieve"];

export function getBatteryPackageSources(config: CrocConfig): string[] {
	const packages: string[] = [];
	if (config.batteries.webSearch.enabled) packages.push(config.batteries.webSearch.packageSource);
	if (config.batteries.piLens.enabled) packages.push(config.batteries.piLens.packageSource);
	return packages;
}

export function getTaskplaneBatteryTools(config: CrocConfig): string[] {
	const tools: string[] = [];
	if (config.batteries.webSearch.enabled) tools.push(...WEB_SEARCH_TOOLS);
	if (shouldRegisterHeadroomBridge(config)) tools.push(...HEADROOM_BRIDGE_TOOLS);
	return tools;
}
