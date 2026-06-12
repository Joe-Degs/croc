import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type CrocConfig, createDefaultConfig } from "../src/core/config.ts";
import {
	assertTrustedHeadroomBridgeOrigin,
	buildManagedHeadroomCommand,
	deriveHeadroomProviderBaseUrl,
	ensureHeadroomReady,
	type HeadroomChildProcess,
	type HeadroomRuntime,
	isHeadroomEnabled,
	validateHeadroomConfig,
} from "../src/core/headroom.ts";

interface HeadroomServer {
	requests: string[];
	url: string;
	close: () => Promise<void>;
}

interface FakeHeadroomChild extends HeadroomChildProcess {
	emitError: (error: Error) => void;
	emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	unrefCalled: boolean;
}

interface ManagedHeadroomStateFixture {
	pid: number;
	url: string;
	mode: "managed";
	command: string;
	telemetry: "off" | "on";
	targets: string[];
	launchHash: string;
	startedAt: string;
	stdoutLog: string;
	stderrLog: string;
}

function createHeadroomConfig(mode: "managed" | "external" = "external"): CrocConfig {
	const config = createDefaultConfig("/tmp/headroom-demo");
	config.batteries.headroom.enabled = true;
	config.batteries.headroom.proxy.mode = mode;
	config.batteries.headroom.proxy.url = "http://127.0.0.1:18787/";
	config.batteries.headroom.proxy.startupTimeoutSeconds = 1;
	config.batteries.headroom.routing.providers = {
		main: { target: "openai" },
	};
	if (mode === "managed") {
		config.batteries.headroom.proxy.targets = {
			openai: { upstreamUrl: "https://api.openai.test/v1?token=secret" },
		};
	}
	return config;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function createTempRuntimeRoot(): string {
	return mkdtempSync(join(tmpdir(), "croc-headroom-"));
}

async function withTempRuntimeRoot(run: (runtimeRoot: string) => Promise<void>): Promise<void> {
	const runtimeRoot = createTempRuntimeRoot();
	try {
		await run(runtimeRoot);
	} finally {
		if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true });
	}
}

function getHeadroomPaths(runtimeRoot: string): Record<"dir" | "pid" | "state" | "stdout" | "stderr", string> {
	const dir = join(runtimeRoot, ".croc", "headroom");
	return {
		dir,
		pid: join(dir, "proxy.pid"),
		state: join(dir, "proxy-state.json"),
		stdout: join(dir, "proxy.stdout.log"),
		stderr: join(dir, "proxy.stderr.log"),
	};
}

function readManagedState(path: string): ManagedHeadroomStateFixture {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	assertManagedHeadroomStateFixture(parsed);
	return parsed;
}

function assertManagedHeadroomStateFixture(value: unknown): asserts value is ManagedHeadroomStateFixture {
	assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
	assert.ok("pid" in value && typeof value.pid === "number");
	assert.ok("url" in value && typeof value.url === "string");
	assert.ok("mode" in value && value.mode === "managed");
	assert.ok("command" in value && typeof value.command === "string");
	assert.ok("telemetry" in value && (value.telemetry === "off" || value.telemetry === "on"));
	assert.ok("targets" in value && Array.isArray(value.targets));
	assert.ok("launchHash" in value && typeof value.launchHash === "string");
	assert.ok("startedAt" in value && typeof value.startedAt === "string");
	assert.ok("stdoutLog" in value && typeof value.stdoutLog === "string");
	assert.ok("stderrLog" in value && typeof value.stderrLog === "string");
}

function ownerMode(path: string): number {
	return statSync(path).mode & 0o777;
}

function createFakeHeadroomChild(pid?: number): FakeHeadroomChild {
	let errorListener: ((error: Error) => void) | undefined;
	let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	const child: FakeHeadroomChild = {
		pid,
		unrefCalled: false,
		onError(listener) {
			errorListener = listener;
		},
		onExit(listener) {
			exitListener = listener;
		},
		unref() {
			child.unrefCalled = true;
		},
		emitError(error) {
			errorListener?.(error);
		},
		emitExit(code, signal) {
			exitListener?.(code, signal);
		},
	};
	return child;
}

function createManagedTestRuntime(
	spawn: HeadroomRuntime["spawnProcess"],
	isPidLive: HeadroomRuntime["isPidLive"] = () => false,
): Partial<HeadroomRuntime> {
	return {
		spawnProcess: spawn,
		isPidLive,
		now: () => new Date("2026-06-11T00:00:00.000Z"),
		delay: async () => {},
		earlyExitWindowMs: 1,
	};
}

async function startHeadroomServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<HeadroomServer> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		handler(request, response);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		requests,
		url: `http://127.0.0.1:${address.port}`,
		close: () => closeServer(server),
	};
}

describe("headroom config validation", () => {
	it("does not require proxy.url when Headroom is disabled", () => {
		const config = createDefaultConfig("/tmp/headroom-demo");

		assert.equal(isHeadroomEnabled(config), false);
		assert.doesNotThrow(() => validateHeadroomConfig(config));
	});

	it("rejects missing and invalid enabled proxy URLs", () => {
		const config = createHeadroomConfig();
		config.batteries.headroom.proxy.url = "";

		assert.throws(() => validateHeadroomConfig(config), /proxy\.url is required/);

		config.batteries.headroom.proxy.url = "not a url";

		assert.throws(() => validateHeadroomConfig(config), /proxy\.url must be a valid URL/);
	});

	it("rejects requireReady false", () => {
		const config = createHeadroomConfig();
		config.batteries.headroom.proxy.requireReady = false;

		assert.throws(() => validateHeadroomConfig(config), /proxy\.requireReady must be true/);
	});

	it("enforces proxy URL root and credential rules", () => {
		const cases = [
			{ url: "http://user:pass@127.0.0.1:18787", message: /must not include credentials/ },
			{ url: "http://127.0.0.1:18787?token=secret", message: /must not include query strings or hashes/ },
			{ url: "http://127.0.0.1:18787#ready", message: /must not include query strings or hashes/ },
			{ url: "http://127.0.0.1:18787/proxy", message: /must not include a path/ },
			{ url: "ftp://127.0.0.1:18787", message: /must use http or https/ },
		];

		for (const entry of cases) {
			const config = createHeadroomConfig();
			config.batteries.headroom.proxy.url = entry.url;

			assert.throws(() => validateHeadroomConfig(config), entry.message);
		}
	});

	it("requires managed proxy URLs to include an explicit port", () => {
		const config = createHeadroomConfig("managed");
		config.batteries.headroom.proxy.url = "http://127.0.0.1";

		assert.throws(() => validateHeadroomConfig(config), /must include an explicit port/);
	});

	it("allows external mode to route built-in targets without local upstream URLs", () => {
		const config = createHeadroomConfig("external");
		config.batteries.headroom.routing.providers = {
			openai: { target: "openai" },
			anthropic: { target: "anthropic" },
		};

		assert.doesNotThrow(() => validateHeadroomConfig(config));
	});

	it("requires managed mode routed targets to exist in proxy.targets", () => {
		const config = createHeadroomConfig("managed");
		config.batteries.headroom.proxy.targets = {};

		assert.throws(() => validateHeadroomConfig(config), /must define proxy\.targets\.openai\.upstreamUrl/);
	});

	it("rejects unsupported v1 targets clearly", () => {
		const config = createHeadroomConfig("external");
		config.batteries.headroom.routing.providers = {
			gemini: { target: "gemini" },
		};

		assert.throws(() => validateHeadroomConfig(config), /target "gemini" is not supported in v1/);
		assert.throws(
			() => deriveHeadroomProviderBaseUrl(config, "cloudcode"),
			/target "cloudcode" is not supported in v1/,
		);
	});
});

describe("headroom URL derivation", () => {
	it("derives OpenAI and Anthropic provider base URLs from the normalized proxy root", () => {
		const config = createHeadroomConfig();
		config.batteries.headroom.proxy.url = "http://127.0.0.1:18787/";

		assert.equal(deriveHeadroomProviderBaseUrl(config, "openai"), "http://127.0.0.1:18787/v1");
		assert.equal(deriveHeadroomProviderBaseUrl(config, "anthropic"), "http://127.0.0.1:18787");
	});
});

describe("managed headroom command", () => {
	it("builds command args with configured host, port, telemetry, and routed upstreams", () => {
		const config = createHeadroomConfig("managed");
		config.batteries.headroom.proxy.command = "python-headroom";
		config.batteries.headroom.proxy.url = "http://localhost:18787/";
		config.batteries.headroom.routing.providers = {
			openai: { target: "openai" },
			anthropic: { target: "anthropic" },
		};
		config.batteries.headroom.proxy.targets = {
			openai: { upstreamUrl: "https://api.openai.test/v1?token=secret" },
			anthropic: { upstreamUrl: "https://api.anthropic.test" },
		};

		assert.deepEqual(buildManagedHeadroomCommand(config), {
			command: "python-headroom",
			args: [
				"proxy",
				"--host",
				"localhost",
				"--port",
				"18787",
				"--no-telemetry",
				"--openai-api-url",
				"https://api.openai.test/v1?token=secret",
				"--anthropic-api-url",
				"https://api.anthropic.test",
			],
		});
	});

	it("uses an unbracketed IPv6 host when building managed command args", () => {
		const config = createHeadroomConfig("managed");
		config.batteries.headroom.proxy.url = "http://[::1]:18787/";

		const command = buildManagedHeadroomCommand(config);

		assert.deepEqual(command.args.slice(0, 5), ["proxy", "--host", "::1", "--port", "18787"]);
	});

	it("omits the no-telemetry flag when telemetry is enabled", () => {
		const config = createHeadroomConfig("managed");
		config.batteries.headroom.proxy.telemetry = "on";

		assert.equal(buildManagedHeadroomCommand(config).args.includes("--no-telemetry"), false);
	});
});

describe("headroom readiness", () => {
	it("polls /readyz and accepts HTTP 200 with ready true", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		try {
			const config = createHeadroomConfig("external");
			config.batteries.headroom.proxy.url = server.url;

			assert.deepEqual(await ensureHeadroomReady("/tmp/runtime", config), {
				mode: "external",
				url: server.url,
				status: "ready",
			});
			assert.deepEqual(server.requests, ["/readyz"]);
		} finally {
			await server.close();
		}
	});

	it("requires readiness responses to be 200 JSON objects with ready true", async () => {
		const cases = [
			{ status: 503, body: JSON.stringify({ ready: true }), contentType: "application/json", message: /HTTP 503/ },
			{
				status: 200,
				body: JSON.stringify({ ready: false }),
				contentType: "application/json",
				message: /ready was not true/,
			},
			{ status: 200, body: "not-json", contentType: "text/plain", message: /malformed JSON/ },
			{
				status: 200,
				body: JSON.stringify([]),
				contentType: "application/json",
				message: /JSON response was not an object/,
			},
		];

		for (const entry of cases) {
			const server = await startHeadroomServer((_request, response) => {
				response.writeHead(entry.status, { "content-type": entry.contentType });
				response.end(entry.body);
			});
			try {
				const config = createHeadroomConfig("external");
				config.batteries.headroom.proxy.url = server.url;
				config.batteries.headroom.proxy.startupTimeoutSeconds = 0.05;

				await assert.rejects(() => ensureHeadroomReady("/tmp/runtime", config), entry.message);
			} finally {
				await server.close();
			}
		}
	});

	it("does not include the proxy URL in readiness failure messages", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: false }));
		});
		try {
			const config = createHeadroomConfig("external");
			config.batteries.headroom.proxy.url = server.url;
			config.batteries.headroom.proxy.startupTimeoutSeconds = 0.05;

			await assert.rejects(
				() => ensureHeadroomReady("/tmp/runtime", config),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.doesNotMatch(error.message, /127\.0\.0\.1:\d+/);
					return true;
				},
			);
		} finally {
			await server.close();
		}
	});

	it("keeps external readiness read-only", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		try {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("external");
				config.batteries.headroom.proxy.url = server.url;

				await ensureHeadroomReady(runtimeRoot, config);

				assert.equal(existsSync(getHeadroomPaths(runtimeRoot).dir), false);
			});
		} finally {
			await server.close();
		}
	});
});

describe("managed headroom lifecycle", () => {
	it("starts a detached proxy, writes safe state, and waits for readiness", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		try {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("managed");
				config.batteries.headroom.proxy.url = server.url;
				const child = createFakeHeadroomChild(321);
				let spawned: { command: string; args: string[]; detached: boolean | undefined; stdio: unknown } | undefined;

				const result = await ensureHeadroomReady(runtimeRoot, config, {
					runtime: createManagedTestRuntime((command, args, options) => {
						spawned = { command, args, detached: options.detached, stdio: options.stdio };
						return child;
					}),
				});

				assert.deepEqual(result, { mode: "managed", url: server.url, status: "started", pid: 321 });
				assert.ok(spawned);
				assert.equal(spawned.command, "headroom");
				assert.deepEqual(spawned.args.slice(0, 5), [
					"proxy",
					"--host",
					"127.0.0.1",
					"--port",
					new URL(server.url).port,
				]);
				assert.equal(spawned.detached, true);
				assert.ok(Array.isArray(spawned.stdio));
				assert.equal(spawned.stdio[0], "ignore");
				assert.equal(typeof spawned.stdio[1], "number");
				assert.equal(typeof spawned.stdio[2], "number");
				assert.equal(child.unrefCalled, true);

				const paths = getHeadroomPaths(runtimeRoot);
				assert.equal(readFileSync(paths.pid, "utf-8"), "321\n");
				const rawState = readFileSync(paths.state, "utf-8");
				const state = readManagedState(paths.state);
				assert.equal(state.pid, 321);
				assert.equal(state.url, server.url);
				assert.equal(state.mode, "managed");
				assert.equal(state.command, "headroom");
				assert.equal(state.telemetry, "off");
				assert.deepEqual(state.targets, ["openai"]);
				assert.match(state.launchHash, /^sha256:[a-f0-9]{64}$/);
				assert.equal(state.startedAt, "2026-06-11T00:00:00.000Z");
				assert.equal(state.stdoutLog, ".croc/headroom/proxy.stdout.log");
				assert.equal(state.stderrLog, ".croc/headroom/proxy.stderr.log");
				assert.doesNotMatch(rawState, /api\.openai\.test|token=secret|--openai-api-url/);
				assert.equal(existsSync(paths.stdout), true);
				assert.equal(existsSync(paths.stderr), true);
				if (process.platform !== "win32") {
					assert.equal(ownerMode(paths.dir), 0o700);
					assert.equal(ownerMode(paths.pid), 0o600);
					assert.equal(ownerMode(paths.state), 0o600);
					assert.equal(ownerMode(paths.stdout), 0o600);
					assert.equal(ownerMode(paths.stderr), 0o600);
				}
				assert.deepEqual(server.requests, ["/readyz"]);
			});
		} finally {
			await server.close();
		}
	});

	it("reuses a live ready process only when state matches the launch config", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		try {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("managed");
				config.batteries.headroom.proxy.url = server.url;
				let spawnCount = 0;

				await ensureHeadroomReady(runtimeRoot, config, {
					runtime: createManagedTestRuntime(() => {
						spawnCount++;
						return createFakeHeadroomChild(321);
					}),
				});

				const reused = await ensureHeadroomReady(runtimeRoot, config, {
					runtime: createManagedTestRuntime(
						() => {
							throw new Error("unexpected spawn");
						},
						(pid) => pid === 321,
					),
				});

				assert.equal(spawnCount, 1);
				assert.deepEqual(reused, { mode: "managed", url: server.url, status: "reused", pid: 321 });
				assert.deepEqual(server.requests, ["/readyz", "/readyz"]);
			});
		} finally {
			await server.close();
		}
	});

	it("cleans stale PID state before starting a fresh managed process", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		try {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("managed");
				config.batteries.headroom.proxy.url = server.url;
				const paths = getHeadroomPaths(runtimeRoot);
				mkdirSync(paths.dir, { recursive: true });
				writeFileSync(paths.pid, "123\n", "utf-8");
				writeFileSync(paths.state, "not-json", "utf-8");

				const result = await ensureHeadroomReady(runtimeRoot, config, {
					runtime: createManagedTestRuntime(
						() => createFakeHeadroomChild(555),
						() => false,
					),
				});

				assert.deepEqual(result, { mode: "managed", url: server.url, status: "started", pid: 555 });
				assert.equal(readFileSync(paths.pid, "utf-8"), "555\n");
				assert.equal(readManagedState(paths.state).pid, 555);
			});
		} finally {
			await server.close();
		}
	});

	it("fails on live mismatched state without spawning or mutating state", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: true }));
		});
		try {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("managed");
				config.batteries.headroom.proxy.url = server.url;
				await ensureHeadroomReady(runtimeRoot, config, {
					runtime: createManagedTestRuntime(() => createFakeHeadroomChild(321)),
				});

				const changed = createHeadroomConfig("managed");
				changed.batteries.headroom.proxy.url = server.url;
				changed.batteries.headroom.proxy.targets.openai = {
					upstreamUrl: "https://api.openai.test/v2?token=changed",
				};
				const paths = getHeadroomPaths(runtimeRoot);
				const originalState = readFileSync(paths.state, "utf-8");

				await assert.rejects(
					() =>
						ensureHeadroomReady(runtimeRoot, changed, {
							runtime: createManagedTestRuntime(
								() => {
									throw new Error("unexpected spawn");
								},
								(pid) => pid === 321,
							),
						}),
					/launch hash does not match/,
				);
				assert.equal(readFileSync(paths.pid, "utf-8"), "321\n");
				assert.equal(readFileSync(paths.state, "utf-8"), originalState);
				assert.deepEqual(server.requests, ["/readyz"]);
			});
		} finally {
			await server.close();
		}
	});

	it("fails on live PID with missing or corrupt state without spawning", async () => {
		for (const stateContent of [undefined, "not-json"]) {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("managed");
				const paths = getHeadroomPaths(runtimeRoot);
				mkdirSync(paths.dir, { recursive: true });
				writeFileSync(paths.pid, "123\n", "utf-8");
				if (stateContent !== undefined) writeFileSync(paths.state, stateContent, "utf-8");

				await assert.rejects(
					() =>
						ensureHeadroomReady(runtimeRoot, config, {
							runtime: createManagedTestRuntime(
								() => {
									throw new Error("unexpected spawn");
								},
								() => true,
							),
						}),
					/state is missing|state is corrupt/,
				);
				assert.equal(readFileSync(paths.pid, "utf-8"), "123\n");
			});
		}
	});

	it("reports early spawn errors without leaving fresh PID state", async () => {
		await withTempRuntimeRoot(async (runtimeRoot) => {
			const config = createHeadroomConfig("managed");
			const child = createFakeHeadroomChild();

			await assert.rejects(
				() =>
					ensureHeadroomReady(runtimeRoot, config, {
						runtime: {
							...createManagedTestRuntime(() => {
								queueMicrotask(() => child.emitError(new Error("spawn headroom ENOENT")));
								return child;
							}),
							delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
							earlyExitWindowMs: 20,
						},
					}),
				/ENOENT.*proxy\.stderr\.log/,
			);

			const paths = getHeadroomPaths(runtimeRoot);
			assert.equal(existsSync(paths.pid), false);
			assert.equal(existsSync(paths.state), false);
		});
	});

	it("reports permission denied spawn errors without leaving fresh PID state", async () => {
		await withTempRuntimeRoot(async (runtimeRoot) => {
			const config = createHeadroomConfig("managed");
			const child = createFakeHeadroomChild();
			const error = Object.assign(new Error("spawn headroom EACCES"), { code: "EACCES" });

			await assert.rejects(
				() =>
					ensureHeadroomReady(runtimeRoot, config, {
						runtime: {
							...createManagedTestRuntime(() => {
								queueMicrotask(() => child.emitError(error));
								return child;
							}),
							delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
							earlyExitWindowMs: 20,
						},
					}),
				/EACCES.*proxy\.stderr\.log/,
			);

			const paths = getHeadroomPaths(runtimeRoot);
			assert.equal(existsSync(paths.pid), false);
			assert.equal(existsSync(paths.state), false);
		});
	});

	it("reports immediate managed process exits without leaving fresh PID state", async () => {
		await withTempRuntimeRoot(async (runtimeRoot) => {
			const config = createHeadroomConfig("managed");
			const child = createFakeHeadroomChild(779);

			await assert.rejects(
				() =>
					ensureHeadroomReady(runtimeRoot, config, {
						runtime: {
							...createManagedTestRuntime(() => {
								queueMicrotask(() => child.emitExit(2, null));
								return child;
							}),
							delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
							earlyExitWindowMs: 20,
						},
					}),
				/exited with code 2.*proxy\.stderr\.log/,
			);

			const paths = getHeadroomPaths(runtimeRoot);
			assert.equal(existsSync(paths.pid), false);
			assert.equal(existsSync(paths.state), false);
		});
	});

	it("removes fresh PID state when a newly started process never becomes ready", async () => {
		const server = await startHeadroomServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ready: false }));
		});
		try {
			await withTempRuntimeRoot(async (runtimeRoot) => {
				const config = createHeadroomConfig("managed");
				config.batteries.headroom.proxy.url = server.url;
				config.batteries.headroom.proxy.startupTimeoutSeconds = 0.03;
				const child = createFakeHeadroomChild(888);

				await assert.rejects(
					() =>
						ensureHeadroomReady(runtimeRoot, config, {
							runtime: {
								...createManagedTestRuntime(() => child),
								delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
								earlyExitWindowMs: 1,
								readinessPollIntervalMs: 5,
							},
						}),
					/not ready before startupTimeoutSeconds elapsed/,
				);

				const paths = getHeadroomPaths(runtimeRoot);
				assert.equal(existsSync(paths.pid), false);
				assert.equal(existsSync(paths.state), false);
				assert.equal(existsSync(paths.stdout), true);
				assert.equal(existsSync(paths.stderr), true);
			});
		} finally {
			await server.close();
		}
	});
});

describe("headroom bridge trusted origins", () => {
	it("allows local bridge origins by default", () => {
		const config = createHeadroomConfig("external");
		config.batteries.headroom.ccr.mode = "bridge";
		config.batteries.headroom.proxy.url = "http://localhost:18787";

		assert.doesNotThrow(() => assertTrustedHeadroomBridgeOrigin(config));
	});

	it("fails closed for non-local bridge origins unless exactly trusted", () => {
		const config = createHeadroomConfig("external");
		config.batteries.headroom.ccr.mode = "bridge";
		config.batteries.headroom.proxy.url = "https://headroom.example.test";

		assert.throws(() => assertTrustedHeadroomBridgeOrigin(config), /origin is not trusted/);

		config.batteries.headroom.ccr.trustedOrigins = ["https://*.example.test"];

		assert.throws(() => assertTrustedHeadroomBridgeOrigin(config), /origin is not trusted/);

		config.batteries.headroom.ccr.trustedOrigins = ["https://headroom.example.test"];

		assert.doesNotThrow(() => assertTrustedHeadroomBridgeOrigin(config));
	});

	it("skips trusted-origin checks when CCR is disabled", () => {
		const config = createHeadroomConfig("external");
		config.batteries.headroom.ccr.mode = "disabled";
		config.batteries.headroom.proxy.url = "https://headroom.example.test";

		assert.doesNotThrow(() => assertTrustedHeadroomBridgeOrigin(config));
	});
});
