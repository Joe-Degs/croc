import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CrocConfig, CrocHeadroomConfig, HeadroomProxyMode, HeadroomTarget } from "./config.ts";
import { spawnProcess } from "./process.ts";
import { redactSensitiveText } from "./redaction.ts";

export interface ManagedHeadroomCommand {
	command: string;
	args: string[];
}

export interface HeadroomEnsureResult {
	mode: "managed" | "external";
	url: string;
	status: "ready" | "started" | "reused";
	pid?: number;
}

interface NormalizedProxyUrl {
	baseUrl: string;
	hostname: string;
	port: string;
	url: URL;
}

interface ReadinessCheckResult {
	ready: boolean;
	reason: string;
}

interface ManagedHeadroomPaths {
	directory: string;
	pidFile: string;
	stateFile: string;
	stdoutLog: string;
	stderrLog: string;
}

interface ManagedHeadroomState {
	pid: number;
	url: string;
	mode: "managed";
	command: string;
	telemetry: "off" | "on";
	targets: SupportedHeadroomTarget[];
	launchHash: string;
	startedAt: string;
	stdoutLog: string;
	stderrLog: string;
}

interface ManagedLaunchConfig {
	url: string;
	mode: "managed";
	command: string;
	telemetry: "off" | "on";
	targets: SupportedHeadroomTarget[];
	launchHash: string;
}

interface EarlyManagedFailure {
	type: "error" | "exit";
	error?: Error;
	code?: number | null;
	signal?: NodeJS.Signals | null;
}

export interface HeadroomChildProcess {
	pid?: number;
	onError(listener: (error: Error) => void): void;
	onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	unref(): void;
}

export interface HeadroomRuntime {
	fetch: (url: string, init: { method: "GET"; signal: AbortSignal }) => Promise<Response>;
	spawnProcess: (command: string, args: string[], options: SpawnOptions) => HeadroomChildProcess;
	isPidLive: (pid: number) => boolean;
	now: () => Date;
	delay: (ms: number) => Promise<void>;
	earlyExitWindowMs: number;
	readinessPollIntervalMs: number;
	readinessRequestTimeoutMs: number;
}

export interface HeadroomEnsureOptions {
	runtime?: Partial<HeadroomRuntime>;
}

type SupportedHeadroomTarget = "openai" | "anthropic";

const LOCAL_BRIDGE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const READINESS_POLL_INTERVAL_MS = 50;
const READINESS_REQUEST_TIMEOUT_MS = 1_000;
const EARLY_EXIT_WINDOW_MS = 250;
const HEADROOM_STATE_DIR = join(".croc", "headroom");
const HEADROOM_PID_FILE = "proxy.pid";
const HEADROOM_STATE_FILE = "proxy-state.json";
const HEADROOM_STDOUT_LOG = "proxy.stdout.log";
const HEADROOM_STDERR_LOG = "proxy.stderr.log";
const HEADROOM_STDOUT_LOG_STATE_PATH = `${HEADROOM_STATE_DIR}/${HEADROOM_STDOUT_LOG}`;
const HEADROOM_STDERR_LOG_STATE_PATH = `${HEADROOM_STATE_DIR}/${HEADROOM_STDERR_LOG}`;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

const DEFAULT_HEADROOM_RUNTIME: HeadroomRuntime = {
	fetch: (url, init) => fetch(url, init),
	spawnProcess: spawnHeadroomProcess,
	isPidLive,
	now: () => new Date(),
	delay,
	earlyExitWindowMs: EARLY_EXIT_WINDOW_MS,
	readinessPollIntervalMs: READINESS_POLL_INTERVAL_MS,
	readinessRequestTimeoutMs: READINESS_REQUEST_TIMEOUT_MS,
};

export function isHeadroomEnabled(config: CrocConfig): boolean {
	return config.batteries.headroom.enabled === true;
}

export function validateHeadroomConfig(config: CrocConfig): void {
	if (!isHeadroomEnabled(config)) return;

	const headroom = config.batteries.headroom;
	assertProxyMode(headroom.proxy.mode);
	normalizeProxyUrl(headroom);
	if (headroom.proxy.telemetry !== "off" && headroom.proxy.telemetry !== "on") {
		throw new Error('Headroom proxy.telemetry must be "off" or "on".');
	}
	if (headroom.proxy.requireReady !== true) {
		throw new Error("Headroom proxy.requireReady must be true in v1.");
	}
	assertPositiveFiniteNumber(headroom.proxy.startupTimeoutSeconds, "Headroom proxy.startupTimeoutSeconds");

	const routedTargets = getRoutedTargets(headroom);
	if (routedTargets.length === 0) {
		throw new Error("Headroom routing.providers must include at least one provider when Headroom is enabled.");
	}

	for (const target of routedTargets) {
		const supportedTarget = assertSupportedTarget(target);
		if (headroom.proxy.mode === "managed") assertManagedTargetConfig(headroom, supportedTarget);
	}

	if (headroom.ccr.mode !== "disabled" && headroom.ccr.mode !== "bridge") {
		throw new Error('Headroom ccr.mode must be "disabled" or "bridge".');
	}
	assertPositiveFiniteNumber(headroom.ccr.timeoutSeconds, "Headroom ccr.timeoutSeconds");
	assertPositiveFiniteNumber(headroom.ccr.maxResultBytes, "Headroom ccr.maxResultBytes");
	if (!Array.isArray(headroom.ccr.trustedOrigins)) {
		throw new Error("Headroom ccr.trustedOrigins must be an array.");
	}
	if (!headroom.ccr.trustedOrigins.every((origin) => typeof origin === "string")) {
		throw new Error("Headroom ccr.trustedOrigins must contain only strings.");
	}
	assertTrustedHeadroomBridgeOrigin(config);
}

export function deriveHeadroomProviderBaseUrl(config: CrocConfig, target: HeadroomTarget): string {
	const supportedTarget = assertSupportedTarget(target);
	const proxy = normalizeProxyUrl(config.batteries.headroom);
	if (supportedTarget === "openai") return `${proxy.baseUrl}/v1`;
	return proxy.baseUrl;
}

export function assertTrustedHeadroomBridgeOrigin(config: CrocConfig): void {
	if (!isHeadroomEnabled(config)) return;

	const headroom = config.batteries.headroom;
	if (headroom.ccr.mode === "disabled") return;
	if (headroom.ccr.mode !== "bridge") {
		throw new Error('Headroom ccr.mode must be "disabled" or "bridge".');
	}

	const proxy = normalizeProxyUrl(headroom);
	const hostname = normalizeHostname(proxy.url.hostname);
	if (LOCAL_BRIDGE_HOSTS.has(hostname)) return;

	const trustedOrigins = new Set(headroom.ccr.trustedOrigins.map(normalizeTrustedOrigin).filter(isString));
	if (!trustedOrigins.has(proxy.baseUrl)) {
		throw new Error("Headroom CCR bridge origin is not trusted. Add the exact origin to ccr.trustedOrigins.");
	}
}

export function buildManagedHeadroomCommand(config: CrocConfig): ManagedHeadroomCommand {
	if (!isHeadroomEnabled(config)) throw new Error("Headroom is disabled.");
	validateHeadroomConfig(config);

	const headroom = config.batteries.headroom;
	if (headroom.proxy.mode !== "managed") {
		throw new Error('Headroom managed command can only be built when proxy.mode is "managed".');
	}

	const proxy = normalizeProxyUrl(headroom);
	const args = ["proxy", "--host", proxy.hostname, "--port", proxy.port];
	if (headroom.proxy.telemetry === "off") args.push("--no-telemetry");

	for (const target of getRoutedTargets(headroom)) {
		const supportedTarget = assertSupportedTarget(target);
		const upstreamUrl = headroom.proxy.targets[supportedTarget]?.upstreamUrl;
		if (supportedTarget === "openai") args.push("--openai-api-url", upstreamUrl ?? "");
		if (supportedTarget === "anthropic") args.push("--anthropic-api-url", upstreamUrl ?? "");
	}

	return { command: headroom.proxy.command, args };
}

export async function ensureHeadroomReady(
	runtimeRoot: string,
	config: CrocConfig,
	options: HeadroomEnsureOptions = {},
): Promise<HeadroomEnsureResult> {
	if (!isHeadroomEnabled(config)) throw new Error("Headroom is disabled.");
	validateHeadroomConfig(config);

	const runtime = getHeadroomRuntime(options.runtime);
	const headroom = config.batteries.headroom;
	const proxy = normalizeProxyUrl(headroom);
	if (headroom.proxy.mode === "managed") return ensureManagedHeadroomReady(runtimeRoot, config, runtime);

	await pollHeadroomReady(proxy.baseUrl, headroom.proxy.startupTimeoutSeconds, runtime);
	return {
		mode: "external",
		url: proxy.baseUrl,
		status: "ready",
	};
}

async function ensureManagedHeadroomReady(
	runtimeRoot: string,
	config: CrocConfig,
	runtime: HeadroomRuntime,
): Promise<HeadroomEnsureResult> {
	const headroom = config.batteries.headroom;
	const proxy = normalizeProxyUrl(headroom);
	const paths = getManagedHeadroomPaths(runtimeRoot);
	const launch = getManagedLaunchConfig(config, proxy);
	ensureManagedHeadroomDirectory(paths);

	const existingPid = readManagedPid(paths.pidFile);
	if (existingPid !== undefined) {
		if (!runtime.isPidLive(existingPid)) {
			removeManagedPidAndState(paths);
		} else {
			const state = readManagedStateForLivePid(paths, existingPid);
			const mismatch = getManagedStateMismatch(state, existingPid, launch);
			if (mismatch) {
				throw new Error(
					`Headroom managed process ${existingPid} is live but ${mismatch}. Stop it manually before retrying.`,
				);
			}

			const result = await checkHeadroomReady(`${launch.url}/readyz`, runtime.readinessRequestTimeoutMs, runtime);
			if (!result.ready) {
				throw new Error(
					`Headroom managed process ${existingPid} is live but not ready (${result.reason}). Stop it manually before retrying.`,
				);
			}

			return {
				mode: "managed",
				url: launch.url,
				status: "reused",
				pid: existingPid,
			};
		}
	} else if (existsSync(paths.stateFile)) {
		rmSync(paths.stateFile, { force: true });
	}

	return startManagedHeadroom(paths, config, launch, runtime);
}

async function startManagedHeadroom(
	paths: ManagedHeadroomPaths,
	config: CrocConfig,
	launch: ManagedLaunchConfig,
	runtime: HeadroomRuntime,
): Promise<HeadroomEnsureResult> {
	const command = buildManagedHeadroomCommand(config);
	const stdoutFd = openManagedLogFile(paths.stdoutLog);
	let stderrFd: number | undefined;
	let child: HeadroomChildProcess;

	try {
		stderrFd = openManagedLogFile(paths.stderrLog);
		child = runtime.spawnProcess(command.command, command.args, {
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		});
	} catch (error) {
		throw new Error(
			`Failed to start Headroom proxy: ${redactErrorMessage(error)}. See ${getSafeLogPath(paths.stderrLog)}.`,
		);
	} finally {
		closeFileDescriptor(stdoutFd);
		if (stderrFd !== undefined) closeFileDescriptor(stderrFd);
	}

	const earlyFailure = await waitForEarlyManagedFailure(child, runtime);
	if (earlyFailure) {
		throw new Error(
			`Failed to start Headroom proxy: ${formatEarlyManagedFailure(earlyFailure)}. See ${getSafeLogPath(paths.stderrLog)}.`,
		);
	}

	if (!Number.isSafeInteger(child.pid) || child.pid === undefined || child.pid <= 0) {
		throw new Error(
			`Failed to start Headroom proxy: child process did not report a PID. See ${getSafeLogPath(paths.stderrLog)}.`,
		);
	}

	child.unref();
	const pid = child.pid;

	writeManagedPid(paths.pidFile, pid);
	writeManagedState(paths.stateFile, createManagedState(pid, launch, runtime.now()));

	try {
		await pollHeadroomReady(launch.url, config.batteries.headroom.proxy.startupTimeoutSeconds, runtime);
	} catch (error) {
		cleanupFreshManagedState(paths, pid);
		throw new Error(
			`Headroom proxy started with pid ${pid} but was not ready before startupTimeoutSeconds elapsed. See ${getSafeLogPath(paths.stderrLog)}. ${redactErrorMessage(error)}`,
		);
	}

	return {
		mode: "managed",
		url: launch.url,
		status: "started",
		pid,
	};
}

function getHeadroomRuntime(overrides: Partial<HeadroomRuntime> | undefined): HeadroomRuntime {
	return { ...DEFAULT_HEADROOM_RUNTIME, ...overrides };
}

function spawnHeadroomProcess(command: string, args: string[], options: SpawnOptions): HeadroomChildProcess {
	const child = spawnProcess(command, args, options);
	return {
		get pid() {
			return child.pid;
		},
		onError(listener) {
			child.once("error", listener);
		},
		onExit(listener) {
			child.once("exit", listener);
		},
		unref() {
			child.unref();
		},
	};
}

function getManagedHeadroomPaths(runtimeRoot: string): ManagedHeadroomPaths {
	const directory = join(runtimeRoot, HEADROOM_STATE_DIR);
	return {
		directory,
		pidFile: join(directory, HEADROOM_PID_FILE),
		stateFile: join(directory, HEADROOM_STATE_FILE),
		stdoutLog: join(directory, HEADROOM_STDOUT_LOG),
		stderrLog: join(directory, HEADROOM_STDERR_LOG),
	};
}

function ensureManagedHeadroomDirectory(paths: ManagedHeadroomPaths): void {
	mkdirSync(paths.directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
	setOwnerOnlyPermissions(paths.directory, OWNER_DIRECTORY_MODE);
}

function openManagedLogFile(path: string): number {
	const fd = openSync(path, "a", OWNER_FILE_MODE);
	setOwnerOnlyPermissions(path, OWNER_FILE_MODE);
	return fd;
}

function writeManagedPid(path: string, pid: number): void {
	writeFileSync(path, `${pid}\n`, { encoding: "utf-8", mode: OWNER_FILE_MODE });
	setOwnerOnlyPermissions(path, OWNER_FILE_MODE);
}

function writeManagedState(path: string, state: ManagedHeadroomState): void {
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf-8", mode: OWNER_FILE_MODE });
	setOwnerOnlyPermissions(path, OWNER_FILE_MODE);
}

function readManagedPid(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	const raw = readFileSync(path, "utf-8").trim();
	if (!/^\d+$/.test(raw)) {
		throw new Error(`Headroom managed PID file is invalid: ${path}. Remove it after confirming no proxy is running.`);
	}

	const pid = Number(raw);
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(`Headroom managed PID file is invalid: ${path}. Remove it after confirming no proxy is running.`);
	}
	return pid;
}

function readManagedStateForLivePid(paths: ManagedHeadroomPaths, pid: number): ManagedHeadroomState {
	if (!existsSync(paths.stateFile)) {
		throw new Error(
			`Headroom managed process ${pid} is live but state is missing. Stop it manually before retrying.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(paths.stateFile, "utf-8"));
	} catch (error) {
		throw new Error(
			`Headroom managed process ${pid} is live but state is corrupt (${redactErrorMessage(error)}). Stop it manually before retrying.`,
		);
	}

	if (!isManagedHeadroomState(parsed)) {
		throw new Error(
			`Headroom managed process ${pid} is live but state is invalid. Stop it manually before retrying.`,
		);
	}
	return parsed;
}

function removeManagedPidAndState(paths: ManagedHeadroomPaths): void {
	rmSync(paths.pidFile, { force: true });
	rmSync(paths.stateFile, { force: true });
}

function cleanupFreshManagedState(paths: ManagedHeadroomPaths, pid: number): void {
	if (readManagedPidIfPresent(paths.pidFile) === pid) rmSync(paths.pidFile, { force: true });
	const state = readManagedStateIfPresent(paths.stateFile);
	if (state?.pid === pid) rmSync(paths.stateFile, { force: true });
}

function readManagedPidIfPresent(path: string): number | undefined {
	try {
		return readManagedPid(path);
	} catch {
		return undefined;
	}
}

function readManagedStateIfPresent(path: string): ManagedHeadroomState | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isManagedHeadroomState(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getManagedLaunchConfig(config: CrocConfig, proxy: NormalizedProxyUrl): ManagedLaunchConfig {
	const headroom = config.batteries.headroom;
	const targets = getSupportedRoutedTargets(headroom);
	const hashPayload = {
		mode: "managed",
		command: headroom.proxy.command,
		url: proxy.baseUrl,
		hostname: proxy.hostname,
		port: proxy.port,
		telemetry: headroom.proxy.telemetry,
		targets: targets.map((target) => ({
			target,
			upstreamUrl: headroom.proxy.targets[target]?.upstreamUrl ?? "",
		})),
	};

	return {
		url: proxy.baseUrl,
		mode: "managed",
		command: headroom.proxy.command,
		telemetry: headroom.proxy.telemetry,
		targets,
		launchHash: `sha256:${createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex")}`,
	};
}

function createManagedState(pid: number, launch: ManagedLaunchConfig, startedAt: Date): ManagedHeadroomState {
	return {
		pid,
		url: launch.url,
		mode: launch.mode,
		command: launch.command,
		telemetry: launch.telemetry,
		targets: launch.targets,
		launchHash: launch.launchHash,
		startedAt: startedAt.toISOString(),
		stdoutLog: HEADROOM_STDOUT_LOG_STATE_PATH,
		stderrLog: HEADROOM_STDERR_LOG_STATE_PATH,
	};
}

function getManagedStateMismatch(
	state: ManagedHeadroomState,
	pid: number,
	launch: ManagedLaunchConfig,
): string | undefined {
	if (state.pid !== pid) return "state PID does not match the live PID";
	if (state.url !== launch.url) return "state URL does not match the current proxy URL";
	if (state.mode !== launch.mode) return "state mode does not match the current proxy mode";
	if (state.command !== launch.command) return "state command does not match the current proxy command";
	if (state.telemetry !== launch.telemetry) return "state telemetry does not match the current proxy telemetry";
	if (!stringArraysEqual(state.targets, launch.targets))
		return "state targets do not match the current routed targets";
	if (state.launchHash !== launch.launchHash) return "state launch hash does not match the current launch config";
	return undefined;
}

function getSupportedRoutedTargets(headroom: CrocHeadroomConfig): SupportedHeadroomTarget[] {
	return getRoutedTargets(headroom).map(assertSupportedTarget).sort();
}

function isManagedHeadroomState(value: unknown): value is ManagedHeadroomState {
	if (!isRecord(value)) return false;
	return (
		Number.isSafeInteger(value.pid) &&
		typeof value.pid === "number" &&
		value.pid > 0 &&
		typeof value.url === "string" &&
		value.url.length > 0 &&
		value.mode === "managed" &&
		typeof value.command === "string" &&
		value.command.length > 0 &&
		(value.telemetry === "off" || value.telemetry === "on") &&
		Array.isArray(value.targets) &&
		value.targets.every((target) => target === "openai" || target === "anthropic") &&
		typeof value.launchHash === "string" &&
		/^sha256:[a-f0-9]{64}$/.test(value.launchHash) &&
		typeof value.startedAt === "string" &&
		!Number.isNaN(Date.parse(value.startedAt)) &&
		value.stdoutLog === HEADROOM_STDOUT_LOG_STATE_PATH &&
		value.stderrLog === HEADROOM_STDERR_LOG_STATE_PATH
	);
}

function isPidLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = getErrorCode(error);
		if (code === "EPERM") return true;
		return false;
	}
}

function getErrorCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function waitForEarlyManagedFailure(
	child: HeadroomChildProcess,
	runtime: HeadroomRuntime,
): Promise<EarlyManagedFailure | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (failure: EarlyManagedFailure | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(failure);
		};

		child.onError((error) => finish({ type: "error", error }));
		child.onExit((code, signal) => finish({ type: "exit", code, signal }));
		runtime.delay(runtime.earlyExitWindowMs).then(
			() => finish(undefined),
			(error: unknown) =>
				finish({ type: "error", error: error instanceof Error ? error : new Error("early failure wait failed") }),
		);
	});
}

function formatEarlyManagedFailure(failure: EarlyManagedFailure): string {
	if (failure.type === "error") return redactErrorMessage(failure.error);
	if (failure.signal) return `exited from signal ${failure.signal}`;
	return `exited with code ${failure.code ?? "unknown"}`;
}

function setOwnerOnlyPermissions(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		return;
	}
}

function closeFileDescriptor(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		return;
	}
}

function getSafeLogPath(path: string): string {
	return path;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function normalizeProxyUrl(headroom: CrocHeadroomConfig): NormalizedProxyUrl {
	const rawUrl = headroom.proxy.url.trim();
	if (rawUrl.length === 0) throw new Error("Headroom proxy.url is required when Headroom is enabled.");

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch (error) {
		throw new Error(`Headroom proxy.url must be a valid URL: ${redactErrorMessage(error)}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Headroom proxy.url must use http or https.");
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new Error("Headroom proxy.url must not include credentials.");
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		throw new Error("Headroom proxy.url must not include query strings or hashes.");
	}
	if (url.pathname !== "/") {
		throw new Error("Headroom proxy.url must not include a path in v1.");
	}
	if (headroom.proxy.mode === "managed" && url.hostname.length === 0) {
		throw new Error("Headroom managed proxy.url must include an explicit hostname and port.");
	}

	const explicitPort = extractExplicitPort(rawUrl);
	if (headroom.proxy.mode === "managed" && !explicitPort) {
		throw new Error("Headroom managed proxy.url must include an explicit port.");
	}

	const port = explicitPort ?? url.port;
	return {
		baseUrl: `${url.protocol}//${formatHost(url.hostname, port)}`,
		hostname: normalizeHostname(url.hostname),
		port,
		url,
	};
}

function assertProxyMode(mode: HeadroomProxyMode): void {
	if (mode !== "managed" && mode !== "external") {
		throw new Error('Headroom proxy.mode must be "managed" or "external".');
	}
}

function assertSupportedTarget(target: HeadroomTarget): SupportedHeadroomTarget {
	if (target === "openai" || target === "anthropic") return target;
	if (target === "gemini" || target === "cloudcode") {
		throw new Error(`Headroom target "${target}" is not supported in v1.`);
	}
	throw new Error(`Headroom target "${String(target)}" is not supported in v1.`);
}

function assertManagedTargetConfig(headroom: CrocHeadroomConfig, target: SupportedHeadroomTarget): void {
	const upstreamUrl = headroom.proxy.targets[target]?.upstreamUrl;
	if (typeof upstreamUrl !== "string" || upstreamUrl.trim().length === 0) {
		throw new Error(`Headroom managed proxy target "${target}" must define proxy.targets.${target}.upstreamUrl.`);
	}
}

function assertPositiveFiniteNumber(value: number, field: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive finite number.`);
	}
}

function getRoutedTargets(headroom: CrocHeadroomConfig): HeadroomTarget[] {
	const targets: HeadroomTarget[] = [];
	const seen = new Set<HeadroomTarget>();
	for (const provider of Object.values(headroom.routing.providers)) {
		if (seen.has(provider.target)) continue;
		seen.add(provider.target);
		targets.push(provider.target);
	}
	return targets;
}

function extractExplicitPort(rawUrl: string): string | undefined {
	const schemeEnd = rawUrl.indexOf("://");
	if (schemeEnd === -1) return undefined;

	const authorityStart = schemeEnd + 3;
	const authorityEnd = rawUrl.slice(authorityStart).search(/[/?#]/);
	const authority = rawUrl.slice(authorityStart, authorityEnd === -1 ? undefined : authorityStart + authorityEnd);
	const host = authority.slice(authority.lastIndexOf("@") + 1);
	if (host.startsWith("[")) {
		const closingBracket = host.indexOf("]");
		if (closingBracket === -1 || host[closingBracket + 1] !== ":") return undefined;
		return host.slice(closingBracket + 2) || undefined;
	}

	const separator = host.lastIndexOf(":");
	if (separator === -1) return undefined;
	return host.slice(separator + 1) || undefined;
}

function formatHost(hostname: string, port: string): string {
	const normalizedHostname = normalizeHostname(hostname);
	const host = normalizedHostname.includes(":") ? `[${normalizedHostname}]` : normalizedHostname;
	return port.length > 0 ? `${host}:${port}` : host;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
}

function normalizeTrustedOrigin(origin: string): string | undefined {
	const trimmed = origin.trim();
	if (trimmed.length === 0 || trimmed.includes("*")) return undefined;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username.length > 0 || url.password.length > 0) return undefined;
	if (url.search.length > 0 || url.hash.length > 0 || url.pathname !== "/") return undefined;
	return `${url.protocol}//${formatHost(url.hostname, extractExplicitPort(trimmed) ?? url.port)}`;
}

function isString(value: string | undefined): value is string {
	return typeof value === "string";
}

async function pollHeadroomReady(baseUrl: string, timeoutSeconds: number, runtime: HeadroomRuntime): Promise<void> {
	const deadline = Date.now() + timeoutSeconds * 1_000;
	let lastFailure = "no readiness response";

	while (Date.now() < deadline) {
		const remainingMs = Math.max(1, deadline - Date.now());
		const result = await checkHeadroomReady(
			`${baseUrl}/readyz`,
			Math.min(runtime.readinessRequestTimeoutMs, remainingMs),
			runtime,
		);
		if (result.ready) return;

		lastFailure = result.reason;
		const sleepMs = Math.min(runtime.readinessPollIntervalMs, Math.max(0, deadline - Date.now()));
		if (sleepMs === 0) break;
		await runtime.delay(sleepMs);
	}

	throw new Error(`Headroom proxy was not ready before startupTimeoutSeconds elapsed (${lastFailure}).`);
}

async function checkHeadroomReady(
	url: string,
	timeoutMs: number,
	runtime: HeadroomRuntime,
): Promise<ReadinessCheckResult> {
	try {
		const response = await runtime.fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
		if (response.status !== 200) return { ready: false, reason: `HTTP ${response.status}` };

		let payload: unknown;
		try {
			payload = JSON.parse(await response.text());
		} catch {
			return { ready: false, reason: "malformed JSON" };
		}

		if (!isRecord(payload)) return { ready: false, reason: "JSON response was not an object" };
		if (payload.ready === true) return { ready: true, reason: "ready" };
		return { ready: false, reason: "ready was not true" };
	} catch (error) {
		return { ready: false, reason: `request failed: ${redactErrorMessage(error)}` };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactErrorMessage(error: unknown): string {
	if (error instanceof Error) return redactSensitiveText(error.message);
	return "unknown error";
}
