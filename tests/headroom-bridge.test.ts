import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type CrocConfig, createDefaultConfig } from "../src/core/config.ts";
import {
	formatHeadroomRetrieveResult,
	type HeadroomRetrieveParams,
	type HeadroomRetriever,
	type RunHeadroomRetrieveOptions,
	runHeadroomRetrieve,
	shouldRegisterHeadroomBridge,
	validateHeadroomRetrieveParams,
} from "../src/core/headroom-bridge.ts";

const VALID_HASH = "abcdefabcdefabcdefabcdef";
const OTHER_HASH = "1234567890abcdefABCDEF12";

describe("headroom bridge registration predicate", () => {
	it("returns false when CCR mode is disabled", () => {
		const config = createBridgeConfig();
		config.batteries.headroom.ccr.mode = "disabled";

		assert.equal(shouldRegisterHeadroomBridge(config), false);
	});

	it("returns false when Headroom is disabled even if CCR mode is bridge", () => {
		const config = createBridgeConfig();
		config.batteries.headroom.enabled = false;

		assert.equal(shouldRegisterHeadroomBridge(config), false);
	});

	it("returns true when CCR mode is bridge", () => {
		const config = createBridgeConfig();

		assert.equal(shouldRegisterHeadroomBridge(config), true);
	});
});

describe("headroom retrieve parameter validation", () => {
	it("accepts a valid hash and optional query", () => {
		assert.deepEqual(validateHeadroomRetrieveParams({ hash: VALID_HASH }), { hash: VALID_HASH });
		assert.deepEqual(validateHeadroomRetrieveParams({ hash: OTHER_HASH, query: "needle" }), {
			hash: OTHER_HASH,
			query: "needle",
		});
	});

	it("rejects invalid and non-string hashes before calling the retriever", async () => {
		let calls = 0;
		const retriever: HeadroomRetriever = {
			async retrieve() {
				calls += 1;
				return null;
			},
		};

		await assert.rejects(() => runHeadroomRetrieve({ hash: "not-a-hash" }, optionsFor(retriever)), /24 hexadecimal/);
		await assert.rejects(() => runHeadroomRetrieve({ hash: 123 }, optionsFor(retriever)), /hash must be a string/);
		await assert.rejects(
			() =>
				runHeadroomRetrieve(
					{ hash: VALID_HASH, extra: "nope" } as unknown as HeadroomRetrieveParams,
					optionsFor(retriever),
				),
			/only accepts hash and query/,
		);
		assert.equal(calls, 0);
	});

	it("rejects non-string queries before calling the retriever", async () => {
		let calls = 0;
		const retriever: HeadroomRetriever = {
			async retrieve() {
				calls += 1;
				return null;
			},
		};

		await assert.rejects(
			() => runHeadroomRetrieve({ hash: VALID_HASH, query: 42 }, optionsFor(retriever)),
			/query must be a string/,
		);
		assert.equal(calls, 0);
	});

	it("rejects queries longer than 1000 characters before calling the retriever", async () => {
		let calls = 0;
		const retriever: HeadroomRetriever = {
			async retrieve() {
				calls += 1;
				return null;
			},
		};

		await assert.rejects(
			() => runHeadroomRetrieve({ hash: VALID_HASH, query: "x".repeat(1001) }, optionsFor(retriever)),
			/1000 characters or fewer/,
		);
		assert.equal(calls, 0);
	});
});

describe("headroom retrieve formatting", () => {
	it("formats direct retrieval content and token metadata", () => {
		const output = formatHeadroomRetrieveResult(
			{
				hash: VALID_HASH,
				originalContent: "original body text",
				originalTokens: 120,
				compressedTokens: 30,
			},
			10_000,
		);

		assert.match(output, /Headroom CCR original content/);
		assert.match(output, new RegExp(VALID_HASH));
		assert.match(output, /Original tokens: 120/);
		assert.match(output, /Compressed tokens: 30/);
		assert.match(output, /original body text/);
	});

	it("formats query retrieval with multiple results", () => {
		const output = formatHeadroomRetrieveResult(
			{
				hash: VALID_HASH,
				query: "needle",
				count: 2,
				results: [
					{ hash: VALID_HASH, originalContent: "first matching content", originalTokens: 10 },
					{ hash: OTHER_HASH, content: "second matching content", compressedTokens: 4 },
				],
			},
			10_000,
		);

		assert.match(output, /Headroom CCR query results/);
		assert.match(output, /Query: needle/);
		assert.match(output, /Count: 2/);
		assert.match(output, /Result 1:/);
		assert.match(output, /first matching content/);
		assert.match(output, /Result 2:/);
		assert.match(output, /second matching content/);
	});

	it("formats missing or expired retrieval as clean text", () => {
		assert.match(formatHeadroomRetrieveResult(null, 10_000), /missing or expired/);
		assert.match(formatHeadroomRetrieveResult({ hash: VALID_HASH, expired: true }, 10_000), /missing or expired/);
	});

	it("formats unknown result shapes as stable JSON", () => {
		const output = formatHeadroomRetrieveResult({ z: 1, a: { c: 3, b: 2 } }, 10_000);

		assert.ok(output.indexOf('"b"') < output.indexOf('"c"'));
		assert.ok(output.indexOf('"a"') < output.indexOf('"z"'));
	});

	it("removes escaped stack frames from unknown JSON result shapes", () => {
		const output = formatHeadroomRetrieveResult(
			{
				message: "boom\n    at sensitiveFrame (/tmp/secret.ts:1:1)\n    at windowsFrame (C:\\secret\\file.ts:2:3)",
			},
			10_000,
		);

		assert.doesNotMatch(output, /sensitiveFrame|windowsFrame|secret|file\.ts|\\n\s+at /);
	});
});

describe("headroom retrieve runtime behavior", () => {
	it("passes a valid hash and query to the retriever", async () => {
		const calls: Array<{ hash: string; options?: { query?: string } }> = [];
		const retriever: HeadroomRetriever = {
			async retrieve(hash, retrieveOptions) {
				calls.push({ hash, options: retrieveOptions });
				return { hash, originalContent: "ok", originalTokens: 2, compressedTokens: 1 };
			},
		};

		const output = await runHeadroomRetrieve({ hash: VALID_HASH, query: "needle" }, optionsFor(retriever));

		assert.match(output, /ok/);
		assert.deepEqual(calls, [{ hash: VALID_HASH, options: { query: "needle" } }]);
	});

	it("returns clean text for retriever timeouts", async () => {
		const retriever: HeadroomRetriever = {
			async retrieve() {
				throw new Error("request timed out\n    at internal stack frame");
			},
		};

		const output = await runHeadroomRetrieve({ hash: VALID_HASH }, optionsFor(retriever));

		assert.match(output, /failed: request timed out/);
		assert.doesNotMatch(output, /internal stack frame/);
		assert.doesNotMatch(output, /\n\s+at /);
	});

	it("returns clean text for Pi aborts", async () => {
		const controller = new AbortController();
		const retriever: HeadroomRetriever = {
			retrieve: () => new Promise(() => {}),
		};

		const outputPromise = runHeadroomRetrieve(
			{ hash: VALID_HASH },
			optionsFor(retriever, { signal: controller.signal }),
		);
		controller.abort();

		assert.match(await outputPromise, /aborted/);
	});

	it("handles late retriever rejection after abort", async () => {
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const controller = new AbortController();
			let rejectRetrieval: ((error: Error) => void) | undefined;
			const retriever: HeadroomRetriever = {
				retrieve: () =>
					new Promise<unknown>((_resolve, reject) => {
						rejectRetrieval = reject;
					}),
			};

			const outputPromise = runHeadroomRetrieve(
				{ hash: VALID_HASH },
				optionsFor(retriever, { signal: controller.signal }),
			);
			controller.abort();
			assert.match(await outputPromise, /aborted/);

			assert.ok(rejectRetrieval);
			rejectRetrieval(new Error("late timeout"));
			await new Promise((resolve) => setImmediate(resolve));

			assert.equal(unhandled.length, 0);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("cannot run against an untrusted non-local URL", async () => {
		let calls = 0;
		const retriever: HeadroomRetriever = {
			async retrieve() {
				calls += 1;
				return { hash: VALID_HASH, originalContent: "ok" };
			},
		};

		await assert.rejects(
			() =>
				runHeadroomRetrieve(
					{ hash: VALID_HASH },
					optionsFor(retriever, { baseUrl: "https://headroom.example.test" }),
				),
			/not trusted/,
		);
		assert.equal(calls, 0);
	});
});

describe("headroom retrieve output safety", () => {
	it("redacts sensitive content before returning text", () => {
		const forbiddenValues = [
			"bearer-value-123456789",
			"url-value-123456789",
			"json-value-123456789",
			"token-value-123456789",
			"csrf-value-123456789",
			"github-value-123456789",
			"pem-value-123456789",
			"cookie-value-123456789",
			"multiline-value-123456789",
		];
		const output = formatHeadroomRetrieveResult(
			{
				hash: VALID_HASH,
				originalContent: [
					"Authorization: Bearer bearer-value-123456789",
					"https://example.test/path?api_key=url-value-123456789&safe=value",
					'{"apiKey":"json-value-123456789","token":"token-value-123456789","csrfToken":"csrf-value-123456789","githubToken":"github-value-123456789","safe":"visible"}',
					"-----BEGIN PRIVATE KEY-----\npem-value-123456789\n-----END PRIVATE KEY-----",
					"Cookie: session=cookie-value-123456789; theme=light",
					"secret: |\n  multiline-value-123456789\n  still-redacted",
				].join("\n"),
				originalTokens: 200,
				compressedTokens: 20,
			},
			10_000,
		);

		for (const value of forbiddenValues) assert.equal(output.includes(value), false, `${value} should be redacted`);
		assert.match(output, /\[redacted/);
		assert.match(output, /safe=value/);
		assert.match(output, /Original tokens: 200/);
		assert.match(output, /Compressed tokens: 20/);
	});

	it("truncates to maxResultBytes without corrupting Unicode", () => {
		const output = formatHeadroomRetrieveResult(
			{
				hash: VALID_HASH,
				originalContent: `prefix ${"🐊".repeat(100)} suffix`,
				originalTokens: 1000,
				compressedTokens: 10,
			},
			140,
		);

		assert.ok(Buffer.byteLength(output, "utf-8") <= 140);
		assert.match(output, /truncated/);
		assert.doesNotMatch(output, /�/);
	});

	it("does not use direct fetch calls in bridge retrieval", () => {
		const source = readFileSync(new URL("../src/core/headroom-bridge.ts", import.meta.url), "utf-8");

		assert.doesNotMatch(source, /\bfetch\s*\(/);
	});
});

function createBridgeConfig(url = "http://127.0.0.1:18787/"): CrocConfig {
	const config = createDefaultConfig("/tmp/croc-headroom-bridge");
	config.batteries.headroom.enabled = true;
	config.batteries.headroom.proxy.mode = "external";
	config.batteries.headroom.proxy.url = url;
	config.batteries.headroom.routing.providers = {
		openai: { target: "openai" },
	};
	config.batteries.headroom.ccr.mode = "bridge";
	return config;
}

function optionsFor(
	retriever: HeadroomRetriever,
	overrides: Partial<Omit<RunHeadroomRetrieveOptions, "retriever">> = {},
): RunHeadroomRetrieveOptions {
	return {
		retriever,
		baseUrl: "http://127.0.0.1:18787/",
		maxResultBytes: 10_000,
		signal: new AbortController().signal,
		...overrides,
	};
}
