import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { CrocConfig } from "./config.ts";
import { deriveHeadroomProviderBaseUrl, isHeadroomEnabled, validateHeadroomConfig } from "./headroom.ts";

export type PiProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStructuredFile(path: string): unknown {
	const raw = readFileSync(path, "utf-8");
	const extension = extname(path).toLowerCase();
	return extension === ".yaml" || extension === ".yml" ? parseYaml(raw) : JSON.parse(raw);
}

function parseModelsFile(path: string): unknown {
	try {
		return parseStructuredFile(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse Pi models file ${path}: ${message}`);
	}
}

function readModelsFileProviders(configPath: string, modelsFile: string): Map<string, PiProviderConfig> {
	const path = resolve(dirname(configPath), modelsFile);
	if (!existsSync(path)) throw new Error(`Configured Pi models file not found: ${path}`);
	const parsed = parseModelsFile(path);
	if (!isRecord(parsed)) throw new Error(`Pi models file ${path} must contain an object.`);
	if (!isRecord(parsed.providers)) throw new Error(`Pi models file ${path} must contain a providers object.`);
	const providers = new Map<string, PiProviderConfig>();
	for (const [name, provider] of Object.entries(parsed.providers)) {
		if (!isRecord(provider)) throw new Error(`Pi models file ${path} provider ${name} must be an object.`);
		providers.set(name, provider as PiProviderConfig);
	}
	return providers;
}

function normalizeTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function assertCompatibleHeadroomBaseUrl(
	providerName: string,
	provider: Record<string, unknown>,
	baseUrl: string,
): void {
	if (provider.baseUrl === undefined) return;
	if (typeof provider.baseUrl !== "string") {
		throw new Error(`pi.models.providers.${providerName}.baseUrl must be a string when routed through Headroom.`);
	}
	if (normalizeTrailingSlashes(provider.baseUrl) === normalizeTrailingSlashes(baseUrl)) return;
	throw new Error(
		`Croc owns the Headroom route for provider "${providerName}", but pi.models.providers.${providerName}.baseUrl conflicts with the derived Headroom URL.`,
	);
}

function applyHeadroomProviderRouting(
	config: CrocConfig,
	providers: Map<string, PiProviderConfig>,
): Map<string, PiProviderConfig> {
	if (!isHeadroomEnabled(config)) return providers;

	validateHeadroomConfig(config);
	const routedProviders = new Map(providers);
	for (const [providerName, route] of Object.entries(config.batteries.headroom.routing.providers)) {
		const baseUrl = deriveHeadroomProviderBaseUrl(config, route.target);
		const provider = routedProviders.get(providerName);
		if (provider === undefined) {
			routedProviders.set(providerName, { baseUrl } as PiProviderConfig);
			continue;
		}
		if (!isRecord(provider)) throw new Error(`pi.models.providers.${providerName} must be an object.`);
		assertCompatibleHeadroomBaseUrl(providerName, provider, baseUrl);
		routedProviders.set(providerName, { ...provider, baseUrl } as PiProviderConfig);
	}
	return routedProviders;
}

export function getConfiguredPiProviders(
	config: CrocConfig,
	configPath: string | undefined,
): Map<string, PiProviderConfig> {
	const providers = new Map<string, PiProviderConfig>();
	const models = config.pi.models;
	if (models.file) {
		if (!configPath) throw new Error("pi.models.file requires CROC_CONFIG to point at the Croc config file.");
		for (const [name, provider] of readModelsFileProviders(configPath, models.file)) providers.set(name, provider);
	}
	for (const [name, provider] of Object.entries(models.providers)) {
		if (!isRecord(provider)) throw new Error(`pi.models.providers.${name} must be an object.`);
		providers.set(name, provider as PiProviderConfig);
	}
	return applyHeadroomProviderRouting(config, providers);
}

export function validatePiModelsConfig(config: CrocConfig, configPath: string): void {
	getConfiguredPiProviders(config, configPath);
}
