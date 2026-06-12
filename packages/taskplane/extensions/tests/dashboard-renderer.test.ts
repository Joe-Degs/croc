import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "./expect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = resolve(__dirname, "../../dashboard/public/app.js");
const STYLE_CSS = resolve(__dirname, "../../dashboard/public/style.css");
const SERVER_CJS = resolve(__dirname, "../../dashboard/server.cjs");

function escapeText(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(ch) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[ch] || ch,
	);
}

class FakeText {
	nodeType = 3;
	parentNode: FakeElement | null = null;
	textContent: string;

	constructor(textContent: string) {
		this.textContent = textContent;
	}

	get innerHTML(): string {
		return escapeText(this.textContent);
	}
}

class FakeClassList {
	el: FakeElement;

	constructor(el: FakeElement) {
		this.el = el;
	}

	add(...classes: string[]): void {
		const current = new Set(this.el.className.split(/\s+/).filter(Boolean));
		for (const cls of classes) current.add(cls);
		this.el.className = Array.from(current).join(" ");
	}

	contains(cls: string): boolean {
		return this.el.className.split(/\s+/).includes(cls);
	}
}

function dataAttributeKey(name: string): string {
	return name
		.slice("data-".length)
		.split("-")
		.map((part, index) => (index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
		.join("");
}

class FakeElement {
	nodeType = 1;
	className = "";
	classList = new FakeClassList(this);
	children: Array<FakeElement | FakeText> = [];
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	parentNode: FakeElement | null = null;
	private ownText = "";
	tagName: string;
	scrollHeight = 0;
	scrollTop = 0;
	id = "";
	type = "";
	private attributes: Record<string, string> = {};
	private listeners: Record<string, Array<() => void>> = {};

	constructor(tagName: string) {
		this.tagName = tagName;
	}

	appendChild<T extends FakeElement | FakeText>(child: T): T {
		if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((existing) => existing !== child);
		child.parentNode = this;
		this.children.push(child);
		return child;
	}

	remove(): void {
		if (!this.parentNode) return;
		this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
		this.parentNode = null;
	}

	setAttribute(name: string, value: string): void {
		const stringValue = String(value);
		this.attributes[name] = stringValue;
		if (name === "id") this.id = stringValue;
		if (name === "class") this.className = stringValue;
		if (name === "type") this.type = stringValue;
		if (name.startsWith("data-")) this.dataset[dataAttributeKey(name)] = stringValue;
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	getAttributes(): Array<[string, string]> {
		return Object.entries(this.attributes);
	}

	addEventListener(name: string, listener: () => void): void {
		this.listeners[name] = [...(this.listeners[name] || []), listener];
	}

	click(): void {
		for (const listener of this.listeners.click || []) listener();
	}

	focus(): void {
		fakeActiveElement = this;
	}

	insertBefore<T extends FakeElement | FakeText>(
		child: T,
		before: FakeElement | FakeText | null,
	): T {
		if (child === before) return child;
		if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((existing) => existing !== child);
		child.parentNode = this;
		if (!before) {
			this.children.push(child);
			return child;
		}
		const index = this.children.indexOf(before);
		if (index < 0) {
			this.children.push(child);
			return child;
		}
		this.children.splice(index, 0, child);
		return child;
	}

	get firstChild(): FakeElement | FakeText | null {
		return this.children[0] || null;
	}

	set textContent(value: string) {
		this.ownText = value;
		this.children = [];
	}

	get textContent(): string {
		return this.ownText + this.children.map((child) => child.textContent).join("");
	}

	get innerHTML(): string {
		const own = escapeText(this.ownText);
		const serializedAttrs = (el: FakeElement) => {
			const attrs = new Map<string, string>();
			if (el.id) attrs.set("id", el.id);
			if (el.className) attrs.set("class", el.className);
			for (const [name, value] of el.getAttributes()) attrs.set(name, value);
			return Array.from(attrs)
				.map(([name, value]) => ` ${name}="${escapeText(value)}"`)
				.join("");
		};
		return (
			own +
			this.children
				.map((child) => {
					if (child instanceof FakeText) return child.innerHTML;
					return `<${child.tagName}${serializedAttrs(child)}>${child.innerHTML}</${child.tagName}>`;
				})
				.join("")
		);
	}

	set innerHTML(value: string) {
		this.children = [];
		this.ownText = value;
	}

	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] || null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		const matches: FakeElement[] = [];
		const visit = (node: FakeElement | FakeText) => {
			if (node instanceof FakeText) return;
			if (selector.startsWith(".")) {
				if (node.className.split(/\s+/).includes(selector.slice(1))) matches.push(node);
			} else if (node.tagName === selector.toLowerCase()) {
				matches.push(node);
			}
			for (const child of node.children) visit(child);
		};
		visit(this);
		return matches;
	}
}

let fakeActiveElement: FakeElement | null = null;

const fakeDocument = {
	createElement(tagName: string): FakeElement {
		return new FakeElement(tagName.toLowerCase());
	},
	createTextNode(text: string): FakeText {
		return new FakeText(text);
	},
};

interface RendererHelpers {
	stripUnsupportedAnsiControls: (text: unknown) => string;
	createOutputBlock: (
		payload: Record<string, unknown>,
		options?: Record<string, unknown>,
	) => FakeElement;
	createTruncationBadge: (payload: Record<string, unknown>) => FakeElement | null;
	appendOutputText: (outputBlock: FakeElement, text: string) => void;
	replaceOutputText: (outputBlock: FakeElement, text: string) => void;
	renderConvEvent: (event: Record<string, unknown>) => string | FakeElement;
	renderV2Event: (event: Record<string, unknown>) => string | FakeElement;
	renderV2AgentEvents: (events: Array<Record<string, unknown>> | Record<string, unknown>) => void;
	applyV2AgentEventsPollResponse: (
		requestId: number,
		data: Array<Record<string, unknown>> | Record<string, unknown>,
		onHasMore?: () => void,
		feedGeneration?: number,
	) => boolean;
	resetV2FeedState: () => void;
	buildAgentEventsEndpoint: (context: Record<string, unknown>) => string;
	renderMessageBodyMarkdown: (text: unknown) => string;
	renderMailboxAuditEvent: (event: Record<string, unknown>) => string;
	renderMailboxDirMessage: (message: Record<string, unknown>) => string;
	renderMessagesPanel: (mailbox: Record<string, unknown> | null) => void;
	getV2State: () => { v2LastCursor: string | null; v2LastSeq: number | null; v2FirstRender: boolean; groupCount: number };
	getV2FeedGeneration: () => number;
	getMaxWorkerFeedItems: () => number;
	setV2Cursor: (cursor: string) => void;
	terminalBody: FakeElement;
	messagesPanel?: FakeElement;
	messagesBody?: FakeElement;
}

interface AgentsPanelRuntime {
	renderAgentsPanel: (registry: Record<string, unknown> | null) => void;
	panel: FakeElement;
	body: FakeElement;
}

interface TelemetryBadgeRuntime {
	telemetryBadgesHtml: (telemetry: Record<string, unknown> | null, suppressRetry?: boolean) => string;
}

function loadHelpers(): RendererHelpers {
	const src = readFileSync(APP_JS, "utf8");
	const start = src.indexOf("const ANSI_FG_CLASSES");
	const end = src.indexOf("/** Format token count", start);
	if (start < 0 || end < 0) throw new Error("renderer helper block not found");
	const helperSrc = src.slice(start, end);
	return new Function(
		"document",
		"TextEncoder",
		`${helperSrc}\nreturn { stripUnsupportedAnsiControls, createOutputBlock, createTruncationBadge, appendOutputText, replaceOutputText };`,
	)(fakeDocument, TextEncoder) as RendererHelpers;
}

function loadRenderers(): RendererHelpers {
	const src = readFileSync(APP_JS, "utf8");
	const helperStart = src.indexOf("function escapeHtml");
	const helperEnd = src.indexOf("/** Format token count", helperStart);
	const v2Start = src.indexOf("function appendRenderedEvent");
	const v2End = src.indexOf("// ── Segment-Scoped STATUS.md Helpers", v2Start);
	const convStart = src.indexOf("function renderConvEvent");
	const convEnd = src.indexOf("// ── Auto-scroll logic", convStart);
	if (helperStart < 0 || helperEnd < 0 || v2Start < 0 || v2End < 0 || convStart < 0 || convEnd < 0) {
		throw new Error("renderer block not found");
	}
	const rendererSrc = [
		"let v2ToolGroups = new Map();",
		src.slice(helperStart, helperEnd),
		src.slice(v2Start, v2End),
		src.slice(convStart, convEnd),
	].join("\n");
	return new Function(
		"document",
		"TextEncoder",
		`${rendererSrc}\nreturn { stripUnsupportedAnsiControls, createOutputBlock, createTruncationBadge, appendOutputText, replaceOutputText, renderConvEvent, renderV2Event };`,
	)(fakeDocument, TextEncoder) as RendererHelpers;
}

function loadWorkerFeedRuntime(): RendererHelpers {
	const src = readFileSync(APP_JS, "utf8");
	const formatStart = src.indexOf("function formatDuration");
	const formatEnd = src.indexOf("function escapeHtml", formatStart);
	const helperStart = src.indexOf("function escapeHtml");
	const helperEnd = src.indexOf("/** Format token count", helperStart);
	const v2Start = src.indexOf("function buildAgentEventsEndpoint");
	const v2End = src.indexOf("// ── Segment-Scoped STATUS.md Helpers", v2Start);
	if (formatStart < 0 || formatEnd < 0 || helperStart < 0 || helperEnd < 0 || v2Start < 0 || v2End < 0) {
		throw new Error("worker feed block not found");
	}
	const terminalBody = new FakeElement("div");
	return new Function(
		"document",
		"TextEncoder",
		"$terminalBody",
		"requestAnimationFrame",
		[
			"let autoScrollOn = false;",
			"let isProgrammaticScroll = false;",
			src.slice(formatStart, formatEnd),
			src.slice(helperStart, helperEnd),
			src.slice(v2Start, v2End),
			"function getV2State() { return { v2LastCursor, v2LastSeq, v2FirstRender, groupCount: v2ToolGroups.size }; }",
			"function getV2FeedGeneration() { return v2FeedGeneration; }",
			"function getMaxWorkerFeedItems() { return MAX_WORKER_FEED_ITEMS; }",
			"function setV2Cursor(cursor) { v2LastCursor = cursor; }",
			"return { stripUnsupportedAnsiControls, createOutputBlock, createTruncationBadge, appendOutputText, replaceOutputText, renderConvEvent: null, renderV2Event, renderV2AgentEvents, applyV2AgentEventsPollResponse, resetV2FeedState, buildAgentEventsEndpoint, getV2State, getV2FeedGeneration, getMaxWorkerFeedItems, setV2Cursor, terminalBody: $terminalBody };",
		].join("\n"),
	)(fakeDocument, TextEncoder, terminalBody, (fn: () => void) => fn()) as RendererHelpers;
}

function loadTelemetryBadgeRuntime(): TelemetryBadgeRuntime {
	const src = readFileSync(APP_JS, "utf8");
	const helperStart = src.indexOf("function escapeHtml");
	const helperEnd = src.indexOf("// ─── Copy to Clipboard", helperStart);
	if (helperStart < 0 || helperEnd < 0) throw new Error("telemetry badge helper block not found");
	return new Function(`${src.slice(helperStart, helperEnd)}\nreturn { telemetryBadgesHtml };`)() as TelemetryBadgeRuntime;
}

function datasetValues(root: FakeElement): string {
	const values: string[] = [];
	const visit = (node: FakeElement | FakeText) => {
		if (node instanceof FakeText) return;
		values.push(...Object.entries(node.dataset).map(([key, value]) => `${key}=${value}`));
		for (const child of node.children) visit(child);
	};
	visit(root);
	return values.join("\n");
}

function attributeValues(root: FakeElement): string {
	const values: string[] = [];
	const visit = (node: FakeElement | FakeText) => {
		if (node instanceof FakeText) return;
		values.push(...node.getAttributes().map(([key, value]) => `${key}=${value}`));
		for (const child of node.children) visit(child);
	};
	visit(root);
	return values.join("\n");
}

function loadAgentsPanelRuntime(): AgentsPanelRuntime {
	const src = readFileSync(APP_JS, "utf8");
	const helperStart = src.indexOf("function formatDuration");
	const helperEnd = src.indexOf("const ANSI_FG_CLASSES", helperStart);
	const agentsStart = src.indexOf("const AGENT_TERMINAL_STATUSES");
	const agentsEnd = src.indexOf("// ─── Render: Mailbox Messages", agentsStart);
	if (helperStart < 0 || helperEnd < 0 || agentsStart < 0 || agentsEnd < 0) {
		throw new Error("agents panel block not found");
	}
	const panel = new FakeElement("section");
	const body = new FakeElement("div");
	const document = {
		getElementById(id: string): FakeElement | null {
			return { "agents-panel": panel, "agents-body": body }[id] || null;
		},
	};
	return new Function(
		"document",
		[
			src.slice(helperStart, helperEnd),
			src.slice(agentsStart, agentsEnd),
			"return { renderAgentsPanel, panel: document.getElementById('agents-panel'), body: document.getElementById('agents-body') };",
		].join("\n"),
	)(document) as AgentsPanelRuntime;
}

function loadMessagesRuntime(): RendererHelpers {
	const src = readFileSync(APP_JS, "utf8");
	const helperStart = src.indexOf("function escapeHtml");
	const helperEnd = src.indexOf("/** Format token count", helperStart);
	const messagesStart = src.indexOf("function renderMessagesPanel");
	const messagesEnd = src.indexOf("// ─── Render: Errors", messagesStart);
	if (helperStart < 0 || helperEnd < 0 || messagesStart < 0 || messagesEnd < 0) {
		throw new Error("messages renderer block not found");
	}
	const messagesPanel = new FakeElement("section");
	const messagesBody = new FakeElement("div");
	const documentWithMessages = {
		...fakeDocument,
		getElementById(id: string): FakeElement | null {
			if (id === "messages-panel") return messagesPanel;
			if (id === "messages-body") return messagesBody;
			return null;
		},
	};

	return new Function(
		"document",
		"TextEncoder",
		"messagesPanel",
		"messagesBody",
		[
			src.slice(helperStart, helperEnd),
			src.slice(messagesStart, messagesEnd),
			"return { renderMessageBodyMarkdown, renderMailboxAuditEvent, renderMailboxDirMessage, renderMessagesPanel, messagesPanel, messagesBody };",
		].join("\n"),
	)(documentWithMessages, TextEncoder, messagesPanel, messagesBody) as RendererHelpers;
}

describe("dashboard safe output renderer", () => {
	it("renders new and legacy compaction telemetry badges", () => {
		const helpers = loadTelemetryBadgeRuntime();

		const activeHtml = helpers.telemetryBadgesHtml({ compactionsStarted: 2, compactionsCompleted: 1 });
		expect(activeHtml).toContain("2 compaction(s) started, 1 completed, 1 active");
		expect(activeHtml).toContain("🗜 1 active");

		const completeHtml = helpers.telemetryBadgesHtml({ compactionsStarted: 1, compactionsCompleted: 1 });
		expect(completeHtml).toContain("🗜 1/1");

		const legacyHtml = helpers.telemetryBadgesHtml({ compactions: 1 });
		expect(legacyHtml).toContain("1 context compaction(s)");
		expect(legacyHtml).toContain("🗜 1");

		const legacyWithZeroLifecycleHtml = helpers.telemetryBadgesHtml({
			compactions: 1,
			compactionsStarted: 0,
			compactionsCompleted: 0,
			compactionActive: 0,
		});
		expect(legacyWithZeroLifecycleHtml).toContain("1 context compaction(s)");
		expect(legacyWithZeroLifecycleHtml).not.toContain("0/0");

		const emptyHtml = helpers.telemetryBadgesHtml({
			compactions: 0,
			compactionsStarted: 0,
			compactionsCompleted: 0,
			compactionActive: 0,
		});
		expect(emptyHtml).not.toContain("telem-compaction");
	});

	it("maps compaction counters to frontend telemetry without raw payloads", () => {
		const serverSrc = readFileSync(SERVER_CJS, "utf8");

		expect(serverSrc).toContain('case "compaction_started"');
		expect(serverSrc).toContain('case "compaction_finished"');
		expect(serverSrc).toContain('case "auto_compaction_start": {');
		expect(serverSrc).not.toContain('case "auto_compaction_start":\n        case "compaction_started"');
		expect(serverSrc).toContain("compactionsStarted: agent.compactionsStarted || 0");
		expect(serverSrc).toContain("compactionsCompleted: agent.compactionsCompleted || 0");
		expect(serverSrc).not.toContain("compactionEvents");
	});

	it("converts red ANSI text into a scoped span", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "plain \x1b[31mred\x1b[0m done" });
		const red = block.querySelector(".ansi-fg-red");

		expect(red?.textContent).toBe("red");
		expect(block.innerHTML).toContain('<span class="ansi-fg-red">red</span> done');
	});

	it("reset clears ANSI styling before following text", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "\x1b[31mred\x1b[0mplain" });
		const spans = block.querySelectorAll(".ansi-fg-red");

		expect(spans.length).toBe(1);
		expect(spans[0]?.textContent).toBe("red");
		expect(block.textContent).toBe("redplain");
		expect(block.innerHTML).toContain('<span class="ansi-fg-red">red</span>plain');
	});

	it("renders HTML-like output as text, not markup", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({
			output: '\x1b[31m<script>alert("x")</script><img src=x onerror=alert(1)> & done\x1b[0m',
		});

		expect(block.querySelector("script")).toBe(null);
		expect(block.querySelector("img")).toBe(null);
		expect(block.innerHTML).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
		expect(block.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; done");
	});

	it("strips OSC links, cursor movement, erase, and unsupported controls", () => {
		const helpers = loadHelpers();
		const raw =
			"a\x1b[2Aup\x1b[Kclean\x1b]8;;https://example.test\x07link\x1b]8;;\x07\x1b[?25l\x1b[?1049h\x00end";
		const block = helpers.createOutputBlock({ output: raw });

		expect(helpers.stripUnsupportedAnsiControls(raw)).toBe("aupcleanlinkend");
		expect(block.textContent).toBe("aupcleanlinkend");
		expect(block.querySelector("a")).toBe(null);
		expect(block.innerHTML.includes("\x1b")).toBe(false);
	});

	it("renders truncation metadata when present", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "abcd", truncated: true, originalBytes: 4096 });
		const badge = block.querySelector(".worker-feed-truncated");

		expect(badge?.textContent).toBe("4 B captured of 4 KB");
		expect(helpers.createTruncationBadge({ truncated: false })).toBe(null);
	});

	it("renders mailbox audit events as stacked feed items", () => {
		const helpers = loadMessagesRuntime();
		const rendered = helpers.renderMailboxAuditEvent({
			type: "message_sent",
			ts: "2026-06-06T00:00:00.000Z",
			to: "lane-2",
			messageType: "status_request",
			content: "Please **check** `STATUS.md`",
		});

		expect(rendered).toContain('<article class="message-feed-item message-event-message_sent">');
		expect(rendered).toContain('<div class="message-meta">');
		expect(rendered).toContain('<div class="message-body">');
		expect(rendered).toContain("→ lane-2");
		expect(rendered).toContain("<strong>check</strong>");
		expect(rendered).toContain('<code class="message-inline-code">STATUS.md</code>');
	});

	it("prefers mailbox audit events over directory fallback messages", () => {
		const helpers = loadMessagesRuntime();
		helpers.renderMessagesPanel({
			auditEvents: [
				{ type: "message_sent", ts: "2026-06-06T00:00:00.000Z", to: "agent", content: "audit wins" },
			],
			messages: [{ to: "agent", content: "directory loses", _status: "pending" }],
		});

		expect(helpers.messagesPanel?.style.display).toBe("");
		expect(helpers.messagesBody?.textContent).toContain("audit wins");
		expect(helpers.messagesBody?.textContent).not.toContain("directory loses");
	});

	it("renders message markdown safely and escapes raw HTML", () => {
		const helpers = loadMessagesRuntime();
		const html = helpers.renderMessageBodyMarkdown(
			[
				"Hello **there** with `code`",
				"",
				"- one",
				"- <img src=x onerror=alert(1)>",
				"",
				"```js",
				'<script>alert("x")</script>',
				"```",
			].join("\n"),
		);

		expect(html).toContain("<strong>there</strong>");
		expect(html).toContain('<code class="message-inline-code">code</code>');
		expect(html).toContain('<ul class="message-list-items"><li>one</li>');
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
	});

	it("escapes mailbox audit metadata and renders unknown events without raw payload dumps", () => {
		const helpers = loadMessagesRuntime();
		const html = helpers.renderMailboxAuditEvent({
			type: "unknown<script>alert(1)</script>",
			from: 'agent<img src=x onerror=alert("x")>',
			payload: '<script>alert("payload")</script>',
			metadata: { secret: "do-not-render" },
			args: { token: "also-hidden" },
			toolCallId: "call-secret",
		});

		expect(html).toContain("unknown&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("agent&lt;img src=x onerror=alert(&quot;x&quot;)&gt;");
		expect(html).toContain("mailbox event recorded");
		expect(html).not.toContain("do-not-render");
		expect(html).not.toContain("also-hidden");
		expect(html).not.toContain("call-secret");
		expect(html).not.toContain("payload");
		expect(html).not.toContain("metadata");
		expect(html).not.toContain("args");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
	});

	it("escapes mailbox directory metadata", () => {
		const helpers = loadMessagesRuntime();
		const html = helpers.renderMailboxDirMessage({
			to: 'lane<img src=x onerror=alert("x")>',
			type: "steer<script>alert(1)</script>",
			_status: "delivered",
			content: "safe body",
		});

		expect(html).toContain("lane&lt;img src=x onerror=alert(&quot;x&quot;)&gt;");
		expect(html).toContain("steer&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
	});

	it("hides the mailbox panel when mailbox data is empty", () => {
		const helpers = loadMessagesRuntime();
		helpers.renderMessagesPanel({ auditEvents: [], messages: [] });

		expect(helpers.messagesPanel?.style.display).toBe("none");
	});

	it("renders legacy tool_result output through the output primitive", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderConvEvent({
			type: "tool_result",
			output: '<script>alert("x")</script><img src=x onerror=alert(1)> & done',
		});

		expect(typeof rendered).toBe("object");
		const block = rendered as FakeElement;
		expect(block.querySelector(".worker-feed-output")?.textContent).toBe(
			'<script>alert("x")</script><img src=x onerror=alert(1)> & done',
		);
		expect(block.querySelector("script")).toBe(null);
		expect(block.querySelector("img")).toBe(null);
		expect(block.innerHTML).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
		expect(block.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; done");
	});

	it("renders structured legacy tool events without object coercion", () => {
		const helpers = loadRenderers();

		const call = helpers.renderConvEvent({
			type: "tool_call",
			toolName: "bash",
			args: { command: { content: [{ text: "npm test", type: "text" }] } },
		}) as string;
		expect(call).toContain("npm test");
		expect(call).not.toContain("[object Object]");

		const result = helpers.renderConvEvent({
			type: "tool_result",
			output: { content: [{ text: "structured output", type: "text" }] },
		}) as FakeElement;
		expect(result.querySelector(".worker-feed-output")?.textContent).toBe("structured output");
		expect(result.textContent).not.toContain("[object Object]");
	});

	it("renders Runtime V2 tool_result text before summary through the output primitive", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_result",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				text: '<svg onload=alert(1)></svg><script>alert("x")</script> & done',
				summary: "short summary",
			},
		});

		expect(typeof rendered).toBe("object");
		const block = rendered as FakeElement;
		expect(block.querySelector(".worker-feed-output")?.textContent).toBe(
			'<svg onload=alert(1)></svg><script>alert("x")</script> & done',
		);
		expect(block.querySelector("svg")).toBe(null);
		expect(block.querySelector("script")).toBe(null);
		expect(block.innerHTML).toContain("&lt;svg onload=alert(1)&gt;&lt;/svg&gt;");
		expect(block.innerHTML).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; done");
		expect(block.textContent).not.toContain("short summary");
	});

	it("collapses long output with accessible disclosure button semantics", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "1\n2\n3\n4\n5\n6\n7\n8" });
		const button = block.querySelector("button");
		const pre = block.querySelector("pre");

		expect(block.textContent).toContain("1\n2\n3\n4\n5\n6");
		expect(block.textContent).not.toContain("7\n8");
		expect(button?.type).toBe("button");
		expect(button?.getAttribute("aria-expanded")).toBe("false");
		expect(button?.getAttribute("aria-label")).toBe("Expand output, 2 more lines");
		expect(button?.getAttribute("aria-controls")).toBe(pre?.id);
		expect(button?.textContent).toBe("... (2 more lines, click to expand)");
	});

	it("does not collapse six lines with a trailing newline", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "1\n2\n3\n4\n5\n6\n" });

		expect(block.querySelector("button")).toBe(null);
		expect(block.textContent).toBe("1\n2\n3\n4\n5\n6\n");
	});

	it("keeps expanded output expanded after append and replace", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "1\n2\n3\n4\n5\n6\n7" });
		block.querySelector("button")?.click();

		expect(block.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(block.textContent).toContain("7");

		helpers.appendOutputText(block, "\n8");
		expect(block.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(block.textContent).toContain("8");

		helpers.replaceOutputText(block, "a\nb\nc\nd\ne\nf\ng\nh");
		expect(block.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(block.textContent).toContain("g\nh");
		expect(block.querySelector("button")?.textContent).toBe("... (collapse output)");
	});

	it("keeps collapse controls reachable at the top and bottom of expanded output", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "1\n2\n3\n4\n5\n6\n7\n8" });
		const button = block.querySelector(".worker-feed-output-disclosure");
		const pre = block.querySelector("pre");

		button?.click();

		const topCollapse = block.querySelector(".worker-feed-output-disclosure");
		const bottomCollapse = block.querySelector(".worker-feed-output-collapse");
		expect(block.children[0]).toBe(topCollapse);
		expect(topCollapse).toBe(button);
		expect(topCollapse?.textContent).toBe("... (collapse output)");
		expect(topCollapse?.getAttribute("aria-expanded")).toBe("true");
		expect(bottomCollapse?.textContent).toBe("... (collapse output)");
		expect(bottomCollapse?.getAttribute("aria-expanded")).toBe("true");
		expect(bottomCollapse?.getAttribute("aria-controls")).toBe(pre?.id);

		bottomCollapse?.click();

		expect(topCollapse?.getAttribute("aria-expanded")).toBe("false");
		expect(block.querySelector(".worker-feed-output-collapse")).toBe(null);
		expect(block.textContent).not.toContain("7\n8");
	});

	it("keeps a focused disclosure control focused through output updates", () => {
		const helpers = loadHelpers();
		const block = helpers.createOutputBlock({ output: "1\n2\n3\n4\n5\n6\n7" });
		const button = block.querySelector("button");
		fakeActiveElement = null;

		button?.focus();
		helpers.appendOutputText(block, "\n8");
		expect(fakeActiveElement).toBe(button);

		helpers.replaceOutputText(block, "a\nb\nc\nd\ne\nf\ng\nh");
		expect(fakeActiveElement).toBe(button);
	});

	it("groups tool calls and final results by toolCallId", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: { toolCallId: "call-1", tool: "bash", displayMode: "terminal", command: "npm test" },
			},
			{
				type: "tool_result",
				ts: "2026-06-06T00:00:01.000Z",
				payload: { toolCallId: "call-1", tool: "bash", text: "pass\nfull output\n", summary: "pass" },
			},
		]);

		const groups = helpers.terminalBody.querySelectorAll(".worker-feed-tool-group");
		expect(groups.length).toBe(1);
		expect(groups[0]?.querySelector(".worker-feed-output")?.textContent).toBe("pass\nfull output\n");
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-tool-result").length).toBe(0);
	});

	it("does not render visible grouped toolCallId text", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: { toolCallId: "call-1", tool: "bash", command: "npm test" },
			},
			{
				type: "tool_result",
				ts: "2026-06-06T00:00:01.000Z",
				payload: { toolCallId: "call-1", tool: "bash", text: "pass" },
			},
		]);

		expect(helpers.terminalBody.textContent).not.toContain("id call-1");
		expect(helpers.terminalBody.textContent).not.toContain("call-1");
		expect(datasetValues(helpers.terminalBody)).not.toContain("call-1");
		expect(helpers.terminalBody.innerHTML).not.toContain("data-tool-call-id");
	});

	it("keeps raw toolCallId out of DOM attributes while grouping internally", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{ type: "tool_call", payload: { toolCallId: "raw-secret-call", tool: "bash", command: "printf ok" } },
			{ type: "tool_output_update", payload: { toolCallId: "raw-secret-call", text: "streamed" } },
			{ type: "tool_result", payload: { toolCallId: "raw-secret-call", tool: "bash", text: "final" } },
		]);

		expect(helpers.terminalBody.querySelectorAll(".worker-feed-tool-group").length).toBe(1);
		expect(helpers.terminalBody.querySelector(".worker-feed-output")?.textContent).toBe("final");
		expect(helpers.terminalBody.textContent).not.toContain("raw-secret-call");
		expect(datasetValues(helpers.terminalBody)).not.toContain("raw-secret-call");
		expect(attributeValues(helpers.terminalBody)).not.toContain("raw-secret-call");
		expect(helpers.terminalBody.innerHTML).not.toContain("raw-secret-call");
		expect(helpers.terminalBody.innerHTML).not.toContain("data-tool-call-id");
	});

	it("fake DOM exposes data attributes set through setAttribute", () => {
		const root = new FakeElement("div");
		const child = new FakeElement("button");
		child.setAttribute("data-tool-call-id", "raw-secret-call");
		root.appendChild(child);

		expect(datasetValues(root)).toContain("toolCallId=raw-secret-call");
		expect(attributeValues(root)).toContain("data-tool-call-id=raw-secret-call");
		expect(root.innerHTML).toContain('data-tool-call-id="raw-secret-call"');
	});

	it("does not render visible unpaired toolCallId text", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_result",
				ts: "2026-06-06T00:00:01.000Z",
				payload: { toolCallId: "call-orphan", tool: "bash", text: "orphan output" },
			},
		]);

		expect(helpers.terminalBody.textContent).toContain("orphan output");
		expect(helpers.terminalBody.textContent).not.toContain("id call-orphan");
		expect(helpers.terminalBody.textContent).not.toContain("call-orphan");
	});

	it("renders unpaired structured output context without object coercion", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_output_update",
				payload: {
					displayMode: { text: "terminal" },
					command: { content: [{ text: "npm test", type: "text" }] },
					path: { text: "/workspace/app" },
					argsPreview: { text: "preview" },
					text: "streamed output",
				},
			},
		]);

		expect(helpers.terminalBody.textContent).toContain("live output · terminal · npm test");
		expect(helpers.terminalBody.textContent).toContain("streamed output");
		expect(helpers.terminalBody.textContent).not.toContain("[object Object]");
	});

	it("renders terminal tools as dollar-prefixed command runs", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: { toolCallId: "call-1", tool: "grep", command: "grep -R needle src" },
		}) as FakeElement;

		expect(rendered.querySelector(".worker-feed-command")?.textContent).toBe("$ grep -R needle src");
		expect(rendered.textContent).not.toContain("GREP");
	});

	it("renders structured terminal display mode as a command run", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				toolCallId: "call-structured-mode",
				tool: "run_command",
				displayMode: { text: "terminal" },
				command: "npm test",
			},
		}) as FakeElement;

		expect(rendered.querySelector(".worker-feed-command")?.textContent).toBe("$ npm test");
		expect(rendered.textContent).not.toContain("[object Object]");
	});

	it("renders structured projection commands as dollar-prefixed command runs", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_execution_start",
				payload: {
					toolCallId: "bash-structured-command",
					tool: "bash",
					argsProjection: {
						version: 1,
						value: { command: { content: [{ text: "npm test", type: "text" }] } },
					},
				},
			},
		]);

		expect(helpers.terminalBody.querySelector(".worker-feed-command")?.textContent).toBe("$ npm test");
		expect(helpers.terminalBody.textContent).not.toContain("[object Object]");
	});

	it("renders bash projections, timeout, tail collapse, expanded output, and final errors", () => {
		const helpers = loadWorkerFeedRuntime();
		const longOutput = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

		helpers.renderV2AgentEvents([
			{
				type: "tool_execution_start",
				payload: {
					toolCallId: "bash-1",
					tool: "bash",
					argsProjection: { version: 1, value: { command: "npm test -- --runInBand", timeout: 120000 } },
				},
			},
			{
				type: "tool_execution_end",
				payload: {
					toolCallId: "bash-1",
					tool: "bash",
					resultProjection: { version: 1, value: { output: longOutput } },
				},
			},
		]);

		const group = helpers.terminalBody.querySelector(".worker-feed-terminal-run");
		const output = group?.querySelector(".worker-feed-output");
		const button = group?.querySelector("button");
		expect(group?.querySelector(".worker-feed-command")?.textContent).toBe("$ npm test -- --runInBand");
		expect(group?.textContent).toContain("tool timeout: 120000");
		expect(output?.textContent).toContain("line 3");
		expect(output?.textContent).toContain("line 12");
		expect(output?.textContent).not.toContain("line 1\nline 2");
		expect(button?.textContent).toBe("... (showing last 10 lines, 2 earlier lines hidden, click to expand)");

		button?.click();
		expect(button?.getAttribute("aria-expanded")).toBe("true");
		expect(output?.textContent).toContain("line 1\nline 2");

		const failed = loadWorkerFeedRuntime();
		failed.renderV2AgentEvents([
			{ type: "tool_call", payload: { toolCallId: "bash-error", tool: "bash", command: "npm test" } },
			{ type: "tool_result", payload: { toolCallId: "bash-error", tool: "bash", isError: true, text: "fatal <error>" } },
		]);
		const failedGroup = failed.terminalBody.querySelector(".worker-feed-terminal-run");
		expect(failedGroup?.classList.contains("worker-feed-tool-error")).toBe(true);
		expect(failedGroup?.querySelector(".worker-feed-output-error")?.textContent).toContain("fatal <error>");
		expect(failedGroup?.querySelector("error")).toBe(null);
	});

	it("renders structured terminal content without object coercion", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_execution_start",
				payload: {
					toolCallId: "bash-structured",
					tool: "bash",
					argsProjection: { version: 1, value: { command: "tail -80 run.log" } },
				},
			},
			{
				type: "tool_execution_update",
				payload: {
					toolCallId: "bash-structured",
					tool: "bash",
					partialResultProjection: { version: 1, value: { content: [{ text: "first chunk\n", type: "text" }] } },
					truncated: true,
					originalBytes: 4096,
				},
			},
			{
				type: "tool_execution_update",
				payload: {
					toolCallId: "bash-structured",
					tool: "bash",
					partialResultProjection: { version: 1, value: { content: [{ text: "first chunk\nsecond chunk\n", type: "text" }] } },
					truncated: true,
					originalBytes: 4096,
				},
			},
			{
				type: "tool_execution_end",
				payload: {
					toolCallId: "bash-structured",
					tool: "bash",
					resultProjection: {
						version: 1,
						value: { content: [{ text: "final chunk\n", type: "text" }] },
						truncated: true,
						originalBytes: 4096,
					},
				},
			},
		]);

		const group = helpers.terminalBody.querySelector(".worker-feed-terminal-run");
		expect(group?.textContent).toContain("final chunk");
		expect(group?.textContent).not.toContain("[object Object]");
		expect(group?.querySelectorAll(".worker-feed-truncated").length).toBe(1);
	});

	it("renders direct ls file tools as dollar-prefixed command runs", () => {
		const helpers = loadRenderers();
		const path =
			"/workspace/fixtures/maelstrom/.croc/workspace/repos/app/.worktrees/operator-20260606T225737/lane-2";
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				toolCallId: "call-ls",
				tool: "ls",
				path,
				argsPreview: path,
				displayMode: "file",
			},
		}) as FakeElement;

		expect(rendered.classList.contains("worker-feed-terminal-run")).toBe(true);
		expect(rendered.querySelector(".worker-feed-command")?.textContent).toBe(`$ ls ${path}`);
		expect(rendered.querySelector(".worker-feed-tool-call-line")).toBe(null);
		expect(rendered.textContent).not.toContain("call-ls");
	});

	it("renders prompts in the prompt transcript primitive", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "prompt_sent",
			ts: "2026-06-06T00:00:00.000Z",
			payload: { text: "run the server for me to test again" },
		}) as FakeElement;

		expect(rendered.classList.contains("worker-feed-prompt")).toBe(true);
		expect(rendered.querySelector(".worker-feed-prompt-text")?.textContent).toBe(
			"run the server for me to test again",
		);
	});

	it("renders verbose terminal commands without trimming path-heavy content", () => {
		const helpers = loadRenderers();
		const command =
			'rm -rf /workspace/fixtures/movie-night/.croc/workspace/packets/taskplane-tasks/TASK-007-add-end-to-end-smoke-tests-and-self-repair-broken-app-flows/ && cd /workspace/fixtures/movie-night/.croc/workspace/packets && git add -A && git commit -m "chore: remove empty TASK-007 folder that was causing discovery crash"';
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: { toolCallId: "call-verbose", tool: "bash", command },
		}) as FakeElement;

		expect(rendered.querySelector(".worker-feed-command")?.textContent).toBe(`$ ${command}`);
		expect(rendered.textContent).toContain(
			"TASK-007-add-end-to-end-smoke-tests-and-self-repair-broken-app-flows",
		);
		expect(rendered.textContent).toContain(
			"chore: remove empty TASK-007 folder that was causing discovery crash",
		);
		expect(rendered.textContent).not.toContain("call-verbose");
	});

	it("keeps command and output text wrappable in the worker feed", () => {
		const css = readFileSync(STYLE_CSS, "utf8");

		expect(css).toMatch(/\.worker-feed-command[\s\S]*?white-space: break-spaces;/);
		expect(css).toMatch(/\.worker-feed-command[\s\S]*?overflow-wrap: anywhere;/);
		expect(css).toMatch(/\.worker-feed-output,[\s\S]*?overflow-x: hidden;/);
		expect(css).toMatch(/\.worker-feed-output pre,[\s\S]*?white-space: pre-wrap;/);
		expect(css).toMatch(/\.worker-feed-output pre,[\s\S]*?overflow-wrap: anywhere;/);
	});

	it("contains multiline message bodies and code blocks without page overflow", () => {
		const css = readFileSync(STYLE_CSS, "utf8");

		expect(css).toMatch(/\.message-feed-item,[\s\S]*?overflow: hidden;/);
		expect(css).toMatch(/\.message-body,[\s\S]*?overflow-wrap: anywhere;/);
		expect(css).toMatch(/\.message-code-block[\s\S]*?max-width: 100%;/);
		expect(css).toMatch(/\.message-code-block[\s\S]*?overflow-x: auto;/);
		expect(css).toMatch(/\.message-code-block[\s\S]*?white-space: pre-wrap;/);
	});

	it("renders web_search tools as compact catchall tool lines", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				toolCallId: "call-search",
				tool: "web_search",
				displayMode: "summary",
				argsPreview: "Maelstrom download compiled release binary jepsen-io github releases",
			},
		}) as FakeElement;

		expect(rendered.classList.contains("worker-feed-tool-call")).toBe(true);
		expect(rendered.querySelector(".worker-feed-tool-call-line")?.textContent).toBe(
			"web_search Maelstrom download compiled release binary jepsen-io github releases",
		);
		expect(rendered.textContent).not.toContain("call-search");
		expect(rendered.textContent).not.toContain("TOOL");
	});

	it("renders web_fetch and unknown tools through the compact catchall", () => {
		const helpers = loadRenderers();
		const fetchRendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				toolCallId: "call-fetch",
				tool: "web_fetch",
				displayMode: "summary",
				argsPreview: "https://fly.io/dist-sys/1/",
			},
		}) as FakeElement;
		const unknownRendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				toolCallId: "call-custom",
				tool: "custom_tool",
				argsPreview: "inspect long custom argument",
			},
		}) as FakeElement;

		expect(fetchRendered.querySelector(".worker-feed-tool-call-line")?.textContent).toBe(
			"web_fetch https://fly.io/dist-sys/1/",
		);
		expect(unknownRendered.querySelector(".worker-feed-tool-call-line")?.textContent).toBe(
			"custom_tool inspect long custom argument",
		);
		expect(`${fetchRendered.textContent} ${unknownRendered.textContent}`).not.toContain("call-");
	});

	it("groups catchall tool output and results without visible toolCallId text", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: {
					toolCallId: "call-search",
					tool: "web_search",
					displayMode: "summary",
					argsPreview: "Maelstrom compiled release",
				},
			},
			{
				type: "tool_output_update",
				ts: "2026-06-06T00:00:01.000Z",
				payload: { toolCallId: "call-search", tool: "web_search", text: "Searching SearXNG...\n" },
			},
			{
				type: "tool_result",
				ts: "2026-06-06T00:00:02.000Z",
				payload: { toolCallId: "call-search", tool: "web_search", text: "Found compiled release" },
			},
		]);

		const groups = helpers.terminalBody.querySelectorAll(".worker-feed-tool-call");
		const outputs = helpers.terminalBody.querySelectorAll(".worker-feed-output");
		expect(groups.length).toBe(1);
		expect(groups[0]?.querySelector(".worker-feed-tool-call-line")?.textContent).toBe(
			"web_search Maelstrom compiled release",
		);
		expect(outputs.length).toBe(1);
		expect(outputs[0]?.textContent).toBe("Found compiled release");
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-tool-result").length).toBe(0);
		expect(helpers.terminalBody.textContent).not.toContain("call-search");
	});

	it("groups direct ls file tool results as terminal command output", () => {
		const helpers = loadWorkerFeedRuntime();
		const path =
			"/workspace/fixtures/maelstrom/.croc/workspace/repos/app/.worktrees/operator-20260606T225737/lane-2";

		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: {
					toolCallId: "call-ls",
					tool: "ls",
					path,
					argsPreview: path,
					displayMode: "file",
				},
			},
			{
				type: "tool_result",
				ts: "2026-06-06T00:00:01.000Z",
				payload: {
					toolCallId: "call-ls",
					tool: "ls",
					displayMode: "file",
					text: ".git\n.tools/\ndocs/\nREADME.md\nstore/\nunique-id/",
				},
			},
		]);

		const groups = helpers.terminalBody.querySelectorAll(".worker-feed-terminal-run");
		const outputs = helpers.terminalBody.querySelectorAll(".worker-feed-output");
		expect(groups.length).toBe(1);
		expect(groups[0]?.querySelector(".worker-feed-command")?.textContent).toBe(`$ ls ${path}`);
		expect(outputs.length).toBe(1);
		expect(outputs[0]?.textContent).toBe(".git\n.tools/\ndocs/\nREADME.md\nstore/\nunique-id/");
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-tool-call-line").length).toBe(0);
		expect(helpers.terminalBody.textContent).not.toContain("call-ls");
	});

	it("renders read tools as compact read lines", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: { toolCallId: "call-1", tool: "read", path: "src/file.ts", startLine: 10, endLine: 20 },
		}) as FakeElement;

		expect(rendered.querySelector(".worker-feed-file-operation")?.textContent).toBe(
			"read src/file.ts:10-20",
		);
		expect(rendered.querySelector(".worker-feed-file-verb")?.textContent).toBe("read");
		expect(rendered.querySelector(".worker-feed-file-path")?.textContent).toBe("src/file.ts");
		expect(rendered.querySelector(".worker-feed-line-range")?.textContent).toBe(":10-20");
		expect(rendered.classList.contains("worker-feed-file-tool")).toBe(true);
		expect(rendered.classList.contains("worker-feed-read-tool")).toBe(true);
		expect(rendered.textContent).not.toContain("call-1");
	});

	it("renders read content from safe projections with compact fallback status", () => {
		const resultWins = loadWorkerFeedRuntime();
		resultWins.renderV2AgentEvents([
			{
				type: "tool_execution_end",
				payload: {
					toolCallId: "read-result",
					tool: "read",
					argsProjection: { version: 1, value: { path: "src/file.ts" } },
					detailsProjection: { version: 1, value: { content: "details content" } },
					resultProjection: { version: 1, value: { content: "result <b>wins</b>" } },
					text: "old payload text",
				},
			},
		]);
		const resultGroup = resultWins.terminalBody.querySelector(".worker-feed-read-tool");
		expect(resultGroup?.textContent).toContain("result <b>wins</b>");
		expect(resultGroup?.textContent).not.toContain("details content");
		expect(resultGroup?.textContent).not.toContain("old payload text");
		expect(resultGroup?.querySelector("b")).toBe(null);
		expect(resultGroup?.innerHTML).toContain("result &lt;b&gt;wins&lt;/b&gt;");

		const detailsWins = loadWorkerFeedRuntime();
		detailsWins.renderV2AgentEvents([
			{
				type: "tool_execution_end",
				payload: {
					toolCallId: "read-details",
					tool: "read",
					argsProjection: { version: 1, value: { path: "src/file.ts" } },
					detailsProjection: { version: 1, value: { content: "details wins" } },
					text: "old payload text",
				},
			},
		]);
		expect(detailsWins.terminalBody.textContent).toContain("details wins");
		expect(detailsWins.terminalBody.textContent).not.toContain("old payload text");

		const oldText = loadWorkerFeedRuntime();
		oldText.renderV2AgentEvents([
			{ type: "tool_execution_end", payload: { toolCallId: "read-old", tool: "read", path: "src/file.ts", text: "legacy text" } },
		]);
		expect(oldText.terminalBody.textContent).toContain("legacy text");

		const missing = loadWorkerFeedRuntime();
		missing.renderV2AgentEvents([
			{ type: "tool_execution_end", payload: { toolCallId: "read-empty", tool: "read", path: "src/file.ts" } },
		]);
		expect(missing.terminalBody.textContent).toContain("completed");
		expect(missing.terminalBody.textContent).not.toContain("undefined");
	});

	it("renders lifecycle notes even with minimal payloads", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "agent_started",
				ts: "2026-06-06T00:00:00.000Z",
				payload: { agentId: "agent-1" },
			},
			{
				type: "prompt_sent",
				ts: "2026-06-06T00:00:01.000Z",
				payload: { text: "do the work" },
			},
		]);

		expect(helpers.terminalBody.textContent).toContain("do the work");
		expect(helpers.terminalBody.textContent).toContain("agent started");
	});

	it("renders edit tools as compact edit lines with collapsible snippets", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_call",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				toolCallId: "call-1",
				tool: "edit",
				path: "src/file.ts",
				snippet: "-1\n-2\n-3\n-4\n-5\n-6\n-7\n-8",
			},
		}) as FakeElement;

		expect(rendered.querySelector(".worker-feed-file-operation")?.textContent).toBe(
			"edit src/file.ts",
		);
		expect(rendered.querySelector(".worker-feed-file-verb")?.textContent).toBe("edit");
		expect(rendered.querySelector(".worker-feed-file-path")?.textContent).toBe("src/file.ts");
		expect(rendered.querySelector("button")).toBe(null);
		expect(rendered.textContent).toContain("-7\n-8");
	});

	it("preserves worker feed live-region attributes", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{ type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "work" } },
		]);
		const feed = helpers.terminalBody.querySelector(".worker-feed");

		expect(feed?.getAttribute("role")).toBe("log");
		expect(feed?.getAttribute("aria-live")).toBe("polite");
		expect(feed?.getAttribute("aria-relevant")).toBe("additions text");
	});

	it("caps compact worker feed items while preserving active pending groups", () => {
		const helpers = loadWorkerFeedRuntime();
		const maxItems = helpers.getMaxWorkerFeedItems();
		const events: Array<Record<string, unknown>> = Array.from({ length: maxItems + 5 }, (_, index) => ({
			type: "prompt_sent",
			payload: { text: `old prompt ${index}` },
		}));
		events.push({
			type: "tool_call",
			payload: { toolCallId: "pending-secret", tool: "bash", command: "sleep 10" },
		});

		helpers.renderV2AgentEvents(events);

		const feed = helpers.terminalBody.querySelector(".worker-feed");
		expect(feed?.children.length).toBe(maxItems);
		expect(feed?.querySelector(".worker-feed-compacted-note")?.textContent).toBe("Older feed items were compacted.");
		expect(feed?.querySelector(".worker-feed-tool-pending")?.textContent).toContain("$ sleep 10");
		expect(feed?.textContent).not.toContain("old prompt 0");
		expect(feed?.textContent).not.toContain("pending-secret");
		expect(datasetValues(feed as FakeElement)).not.toContain("pending-secret");
	});

	it("grows the worker feed pane with visible history up to a cap", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents({
			events: [
				{ seq: 1, type: "prompt_sent", payload: { text: "short 1" } },
				{ seq: 2, type: "prompt_sent", payload: { text: "short 2" } },
			],
			minSeq: 1,
			maxSeq: 2,
			cursorSatisfied: true,
			resetRequired: false,
		});

		expect(helpers.terminalBody.style.maxHeight).toBe("min(332px, 72vh)");

		helpers.renderV2AgentEvents({
			events: Array.from({ length: 22 }, (_, index) => ({
				seq: index + 1,
				type: "prompt_sent",
				payload: { text: `history ${index + 1}` },
			})),
			minSeq: 1,
			maxSeq: 22,
			cursorSatisfied: true,
			resetRequired: false,
		});

		expect(helpers.terminalBody.style.maxHeight).toBe("min(920px, 72vh)");
		expect(helpers.terminalBody.textContent).not.toContain("Feed history gap");
	});

	it("updates worker feed pane height when an empty reset envelope appends a gap warning", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents({
			events: [{ seq: 1, type: "prompt_sent", payload: { text: "already visible" } }],
			minSeq: 1,
			maxSeq: 1,
			cursorSatisfied: true,
			resetRequired: false,
		});

		expect(helpers.terminalBody.style.maxHeight).toBe("min(248px, 72vh)");

		helpers.renderV2AgentEvents({
			events: [],
			hasMore: false,
			cursorSatisfied: false,
			resetRequired: true,
		});

		expect(helpers.terminalBody.textContent).toContain("Feed history gap");
		expect(helpers.terminalBody.style.maxHeight).toBe("min(332px, 72vh)");
	});

	it("renders Runtime V2 write projections safely with state text", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{
				type: "tool_execution_start",
				payload: {
					toolCallId: "write-1",
					tool: "write",
					argsProjection: { version: 1, value: { path: "docs/<x>.md", content: "<script>x</script>\nline" } },
				},
			},
			{ type: "tool_execution_end", payload: { toolCallId: "write-1", tool: "write", summary: "wrote" } },
		]);

		const group = helpers.terminalBody.querySelector(".worker-feed-write-tool");
		expect(group?.classList.contains("worker-feed-tool-success")).toBe(true);
		expect(group?.textContent).toContain("completed");
		expect(group?.textContent).toContain("<script>x</script>");
		expect(group?.querySelector("script")).toBe(null);
		expect(group?.innerHTML).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(group?.textContent).not.toContain("write-1");
	});

	it("renders edit projection diffs with escaped classified lines", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{
				type: "tool_execution_end",
				payload: {
					toolCallId: "edit-1",
					tool: "edit",
					argsProjection: { version: 1, value: { path: "src/app.ts", edits: "old args" } },
					detailsProjection: { version: 1, value: { diff: "diff --git a b\n@@ -1 +1 @@\n-<b>old</b>\n+<script>new</script>" } },
				},
			},
		]);

		const group = helpers.terminalBody.querySelector(".worker-feed-edit-tool");
		expect(group?.querySelector(".worker-feed-diff-meta")?.textContent).toContain("diff --git");
		expect(group?.querySelector(".worker-feed-diff-hunk")?.textContent).toContain("@@");
		expect(group?.querySelector(".worker-feed-diff-removed")?.textContent).toContain("<b>old</b>");
		expect(group?.querySelector(".worker-feed-diff-added")?.textContent).toContain("<script>new</script>");
		expect(group?.querySelector("script")).toBe(null);
		expect(group?.textContent).not.toContain("old args");
	});

	it("recovers paths and previews from malformed edit args", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				payload: {
					toolCallId: "edit-json",
					tool: "edit",
					displayMode: "edit",
					path: "",
					argsProjection: {
						version: 1,
						value: {
							edits:
								'\n[{"oldText":"old <b>text</b>","newText":"new <script>x</script>","path":"docs/broadcast-notes.md"}]',
						},
					},
				},
			},
			{
				type: "tool_call",
				payload: {
					toolCallId: "edit-array",
					tool: "edit",
					displayMode: "edit",
					path: "",
					argsProjection: {
						version: 1,
						value: {
							edits: [
								{
									oldText: "unchecked",
									newText: "checked",
									path: "/tmp/task/STATUS.md",
								},
							],
						},
					},
				},
			},
		]);

		const groups = helpers.terminalBody.querySelectorAll(".worker-feed-edit-tool");
		expect(groups[0]?.querySelector(".worker-feed-file-operation")?.textContent).toBe(
			"edit docs/broadcast-notes.md",
		);
		expect(groups[0]?.textContent).toContain("old:\nold <b>text</b>");
		expect(groups[0]?.textContent).toContain("new:\nnew <script>x</script>");
		expect(groups[0]?.textContent).not.toContain('[{"oldText"');
		expect(groups[0]?.querySelector("script")).toBe(null);
		expect(groups[0]?.innerHTML).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(groups[1]?.querySelector(".worker-feed-file-operation")?.textContent).toBe(
			"edit /tmp/task/STATUS.md",
		);
		expect(groups[1]?.textContent).toContain("old:\nunchecked");
		expect(groups[1]?.textContent).toContain("new:\nchecked");
		expect(helpers.terminalBody.textContent).not.toContain("(unknown path)");
	});

	it("folds assistant and thinking updates into stable stream blocks", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{ type: "assistant_message_update", payload: { messageId: "m1", text: "first" } },
			{ type: "assistant_message_update", payload: { messageId: "m1", text: "second", done: true } },
			{ type: "assistant_thinking_update", payload: { streamId: "t1", text: "thinking 1" } },
			{ type: "assistant_thinking_update", payload: { streamId: "t1", text: "thinking 2", done: true } },
		]);

		expect(helpers.terminalBody.querySelectorAll(".worker-feed-assistant").length).toBe(1);
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-thinking").length).toBe(1);
		expect(helpers.terminalBody.textContent).toContain("second");
		expect(helpers.terminalBody.textContent).not.toContain("first");
		expect(helpers.terminalBody.textContent).toContain("thinking 2");
	});

	it("renders snapshot-only assistant updates and closes fallback streams on isFinal", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{ type: "assistant_message_update", payload: { snapshot: "first snapshot", isFinal: true } },
			{ type: "assistant_message_update", payload: { text: "second stream", isFinal: true } },
			{ type: "assistant_thinking_update", payload: { text: "thinking first", isFinal: true } },
			{ type: "assistant_thinking_update", payload: { text: "thinking second", isFinal: true } },
		]);

		expect(helpers.terminalBody.querySelectorAll(".worker-feed-assistant").length).toBe(2);
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-thinking").length).toBe(2);
		expect(helpers.terminalBody.textContent).toContain("first snapshot");
		expect(helpers.terminalBody.textContent).toContain("second stream");
		expect(helpers.terminalBody.textContent).toContain("thinking first");
		expect(helpers.terminalBody.textContent).toContain("thinking second");
	});

	it("renders workflow notes without raw payload leaks", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{ type: "agent_started", payload: { cwd: "packages/<task>", model: "model<script>" } },
			{ type: "retry_finished", payload: { attempt: 2, success: false, error: "failed <b>bad</b>" } },
			{ type: "context_usage", payload: { percent: 72, pct: 12 } },
			{ type: "reply_sent", payload: { content: "hello <script>x</script>" } },
			{ type: "unknown_event", seq: 9, payload: { toolCallId: "secret-call", args: { token: "nope" }, summary: "safe <x>" } },
		]);

		expect(helpers.terminalBody.textContent).toContain("agent started in packages/<task> using model<script>");
		expect(helpers.terminalBody.textContent).toContain("retry finished");
		expect(helpers.terminalBody.textContent).toContain("context usage 72%");
		expect(helpers.terminalBody.textContent).toContain("reply sent: hello <script>x</script>");
		expect(helpers.terminalBody.textContent).toContain("unknown event · seq 9 · safe <x>");
		expect(helpers.terminalBody.textContent).not.toContain("secret-call");
		expect(helpers.terminalBody.textContent).not.toContain("token");
		expect(helpers.terminalBody.querySelector("script")).toBe(null);
	});

	it("caps agent start fields and unknown event labels", () => {
		const helpers = loadWorkerFeedRuntime();
		const longCwd = `/tmp/${"c".repeat(180)}`;
		const longModel = `model-${"m".repeat(180)}`;
		const longType = `custom_${"event_".repeat(40)}`;

		helpers.renderV2AgentEvents([
			{ type: "agent_started", payload: { cwd: longCwd, model: longModel } },
			{ type: longType, payload: { summary: "safe summary" } },
		]);

		const text = helpers.terminalBody.textContent;
		expect(text).toContain(`${longCwd.slice(0, 120)}…`);
		expect(text).toContain(`${longModel.slice(0, 120)}…`);
		expect(text).not.toContain("c".repeat(121));
		expect(text).not.toContain("m".repeat(121));
		expect(text).toContain(`${longType.replace(/_/g, " ").slice(0, 120)}…`);
		expect(text).toContain("safe summary");
	});

	it("renders representative workflow events with safe labels and capped previews", () => {
		const helpers = loadWorkerFeedRuntime();
		const longPreview = "x".repeat(260);

			helpers.renderV2AgentEvents([
			{ type: "agent_exited", payload: { durationMs: 125000 } },
			{ type: "agent_crashed", payload: { exitCode: 2, error: "panic <bad>" } },
			{ type: "agent_killed", payload: { reason: "operator stop" } },
			{ type: "agent_timeout", payload: { timeoutMs: 61000, reason: "too slow" } },
			{ type: "retry_started", payload: { attempt: 2, maxAttempts: 3, error: longPreview } },
			{ type: "compaction_started", payload: {} },
			{ type: "compaction_finished", payload: { success: true, summary: "saved context" } },
			{ type: "compaction_finished", payload: { status: "skipped", success: false } },
			{ type: "message_delivered", payload: { broadcast: true, content: "broadcast body" } },
			{ type: "message_delivered", payload: { to: "lane-1", content: "direct body" } },
			{ type: "escalation_sent", payload: { content: "needs supervisor" } },
			{ type: "exit_intercepted", payload: { action: "continue", reason: "unfinished" } },
			{ type: "context_usage", payload: { percent: "not-a-number" } },
			{ type: "context_usage", payload: {} },
			{ type: "reply_sent", payload: {} },
		]);

		const text = helpers.terminalBody.textContent;
		expect(text).toContain("agent exited after 2m 05s");
		expect(text).toContain("agent crashed with exit code 2 : panic <bad>");
		expect(text).toContain("agent killed: operator stop");
		expect(text).toContain("agent timed out after 1m 01s : too slow");
		expect(text).toContain("retry started, attempt 2 of 3");
		expect(text).toContain(`${"x".repeat(240)}…`);
		expect(text).not.toContain("x".repeat(241));
		expect(text).toContain("compaction started");
		expect(text).toContain("compaction finished: saved context");
		expect(text).toContain("compaction skipped");
		expect(text).toContain("mailbox broadcast delivered: broadcast body");
		expect(text).toContain("direct message delivered: direct body");
		expect(text).toContain("escalation sent: needs supervisor");
		expect(text).toContain("exit intercepted: continue: unfinished");
		expect(text.match(/context usage updated/g)?.length).toBe(2);
		expect(text).toContain("reply sent");
		expect(helpers.terminalBody.querySelector("bad")).toBe(null);
	});

	it("defines tool state and wrapping CSS hooks", () => {
		const css = readFileSync(STYLE_CSS, "utf8");
		const fileOperationRule = css.match(/\.worker-feed-file-operation \{[\s\S]*?\n\}/)?.[0] || "";

		expect(css).toContain("--feed-tool-pending-bg: #282832;");
		expect(css).toContain("--feed-tool-success-bg: #283228;");
		expect(css).toContain("--feed-tool-error-bg: #3c2828;");
		expect(css).toMatch(/\.worker-feed-file-operation[\s\S]*?background: var\(--feed-terminal-bg\);/);
		expect(fileOperationRule).not.toContain("border-bottom");
		expect(css).toMatch(/\.worker-feed-file-operation \.worker-feed-file-path,[\s\S]*?font-size: inherit;/);
		expect(css).toMatch(/\.worker-feed-file-operation \.worker-feed-file-path \{[\s\S]*?font-weight: 400;/);
		expect(css).toMatch(/\.worker-feed-tool-pending[\s\S]*?background: var\(--feed-tool-pending-bg\);/);
		expect(css).toMatch(/\.worker-feed-tool-success[\s\S]*?background: var\(--feed-tool-success-bg\);/);
		expect(css).toMatch(/\.worker-feed-tool-error[\s\S]*?background: var\(--feed-tool-error-bg\);/);
		expect(css).toMatch(/\.worker-feed-diff-line[\s\S]*?overflow-wrap: anywhere;/);
		expect(css).toMatch(/\.worker-feed-output-disclosure:focus-visible/);
		expect(css).toMatch(/\.worker-feed-output-collapse:focus-visible/);
	});

	it("appends tool_output_update to the matching output block", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: { toolCallId: "call-1", tool: "bash", command: "printf" },
			},
		]);
		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: { toolCallId: "call-1", tool: "bash", command: "printf" },
			},
			{
				type: "tool_output_update",
				ts: "2026-06-06T00:00:01.000Z",
				payload: { toolCallId: "call-1", text: "hello " },
			},
			{
				type: "tool_output_update",
				ts: "2026-06-06T00:00:02.000Z",
				payload: { toolCallId: "call-1", text: "world" },
			},
		]);

		const outputs = helpers.terminalBody.querySelectorAll(".worker-feed-output");
		expect(outputs.length).toBe(1);
		expect(outputs[0]?.textContent).toBe("hello world");
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-tool-result").length).toBe(0);
	});

	it("prefers explicit output deltas over cumulative partial projections", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{ type: "tool_call", payload: { toolCallId: "call-1", tool: "bash", command: "printf" } },
			{
				type: "tool_output_update",
				payload: {
					toolCallId: "call-1",
					tool: "bash",
					text: "one\n",
					partialResultProjection: { version: 1, value: { output: "one\n" } },
				},
			},
			{
				type: "tool_output_update",
				payload: {
					toolCallId: "call-1",
					tool: "bash",
					text: "two\n",
					partialResultProjection: { version: 1, value: { output: "one\ntwo\n" } },
				},
			},
		]);

		const output = helpers.terminalBody.querySelector(".worker-feed-output");
		expect(output?.textContent).toBe("one\ntwo\n");
	});

	it("resets cursor and grouping state for worker and history switches", () => {
		const helpers = loadWorkerFeedRuntime();
		helpers.renderV2AgentEvents([
			{
				type: "tool_call",
				ts: "2026-06-06T00:00:00.000Z",
				payload: { toolCallId: "call-1", tool: "bash", command: "ls" },
			},
		]);

		expect(helpers.getV2State().v2FirstRender).toBe(false);
		expect(helpers.getV2State().groupCount).toBe(1);
		helpers.resetV2FeedState();

		expect(helpers.getV2State()).toEqual({ v2LastCursor: null, v2LastSeq: null, v2FirstRender: true, groupCount: 0 });
	});

	it("advances worker feed endpoints with afterSeq after sequenced events", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents([
			{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "first" } },
		]);

		expect(helpers.getV2State().v2LastSeq).toBe(1);
		expect(helpers.buildAgentEventsEndpoint({ agentId: "agent-1" })).toBe(
			"/api/agent-events/agent-1?afterSeq=1",
		);
		expect(helpers.buildAgentEventsEndpoint({ agentId: "agent-1", batchId: "batch-old" })).toBe(
			"/api/agent-events/agent-1?batchId=batch-old&afterSeq=1",
		);
	});

	it("accepts cursor envelopes and ignores already-applied sequenced events", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents({
			events: [
				{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "first" } },
				{ seq: 2, type: "prompt_sent", ts: "2026-06-06T00:00:01.000Z", payload: { text: "second" } },
			],
			minSeq: 1,
			maxSeq: 2,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});
		helpers.renderV2AgentEvents({
			events: [
				{ seq: 2, type: "prompt_sent", ts: "2026-06-06T00:00:01.000Z", payload: { text: "second duplicate" } },
				{ seq: 3, type: "prompt_sent", ts: "2026-06-06T00:00:02.000Z", payload: { text: "third" } },
			],
			minSeq: 1,
			maxSeq: 3,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});

		expect(helpers.terminalBody.textContent).toContain("first");
		expect(helpers.terminalBody.textContent).toContain("second");
		expect(helpers.terminalBody.textContent).toContain("third");
		expect(helpers.terminalBody.textContent).not.toContain("second duplicate");
		expect(helpers.getV2State().v2LastSeq).toBe(3);
	});

	it("ignores stale worker feed poll responses after a newer response applies", () => {
		const helpers = loadWorkerFeedRuntime();

		const appliedNewer = helpers.applyV2AgentEventsPollResponse(2, {
			events: [
				{ seq: 2, type: "prompt_sent", ts: "2026-06-06T00:00:01.000Z", payload: { text: "newer" } },
			],
			minSeq: 2,
			maxSeq: 2,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});
		const appliedStale = helpers.applyV2AgentEventsPollResponse(1, {
			events: [
				{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "stale" } },
			],
			minSeq: 1,
			maxSeq: 1,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});

		expect(appliedNewer).toBe(true);
		expect(appliedStale).toBe(false);
		expect(helpers.terminalBody.textContent).toContain("newer");
		expect(helpers.terminalBody.textContent).not.toContain("stale");
		expect(helpers.getV2State().v2LastSeq).toBe(2);
	});

	it("ignores stale worker feed poll responses from a previous feed generation", () => {
		const helpers = loadWorkerFeedRuntime();
		const staleGeneration = helpers.getV2FeedGeneration();

		helpers.resetV2FeedState();
		const appliedStale = helpers.applyV2AgentEventsPollResponse(
			1,
			{
				events: [
					{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "stale" } },
				],
				minSeq: 1,
				maxSeq: 1,
				hasMore: false,
				cursorSatisfied: true,
				resetRequired: false,
			},
			undefined,
			staleGeneration,
		);

		expect(appliedStale).toBe(false);
		expect(helpers.terminalBody.textContent).not.toContain("stale");
		expect(helpers.getV2State().v2LastSeq).toBeNull();
	});

	it("preserves legacy bare-array cursor behavior for unsequenced events after seq cursor exists", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents({
			events: [
				{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "first" } },
			],
			minSeq: 1,
			maxSeq: 1,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});
		helpers.renderV2AgentEvents([
			{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "first" } },
			{ type: "prompt_sent", ts: "2026-06-06T00:00:01.000Z", payload: { text: "legacy unsequenced" } },
		]);

		expect(helpers.terminalBody.textContent).toContain("first");
		expect(helpers.terminalBody.textContent).toContain("legacy unsequenced");
		expect(helpers.getV2State().v2LastSeq).toBe(1);
	});

	it("signals an immediate worker feed follow-up when a cursor envelope has more events", () => {
		const helpers = loadWorkerFeedRuntime();
		let followUps = 0;

		const applied = helpers.applyV2AgentEventsPollResponse(
			1,
			{
				events: [
					{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "first" } },
				],
				minSeq: 1,
				maxSeq: 1,
				hasMore: true,
				cursorSatisfied: true,
				resetRequired: false,
			},
			() => {
				followUps += 1;
			},
		);

		expect(applied).toBe(true);
		expect(followUps).toBe(1);
		expect(helpers.getV2State().v2LastSeq).toBe(1);
	});

	it("shows a compact history gap warning for reset envelopes", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents({
			events: [
				{ seq: 10, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "tail" } },
			],
			minSeq: 10,
			maxSeq: 10,
			hasMore: false,
			cursorSatisfied: false,
			resetRequired: true,
		});

		expect(helpers.terminalBody.textContent).toContain("Feed history gap: older events are unavailable, keeping visible history and appending latest events.");
		expect(helpers.terminalBody.textContent).toContain("tail");
		expect(helpers.getV2State().v2LastSeq).toBe(10);
	});

	it("preserves visible worker feed history when a cursor envelope falls behind", () => {
		const helpers = loadWorkerFeedRuntime();

		helpers.renderV2AgentEvents({
			events: [
				{ seq: 1, type: "prompt_sent", ts: "2026-06-06T00:00:00.000Z", payload: { text: "already visible" } },
			],
			minSeq: 1,
			maxSeq: 1,
			hasMore: false,
			cursorSatisfied: true,
			resetRequired: false,
		});
		helpers.renderV2AgentEvents({
			events: [
				{ seq: 10, type: "prompt_sent", ts: "2026-06-06T00:00:10.000Z", payload: { text: "tail after gap" } },
			],
			minSeq: 10,
			maxSeq: 10,
			hasMore: false,
			cursorSatisfied: false,
			resetRequired: true,
		});
		helpers.renderV2AgentEvents({
			events: [
				{ seq: 10, type: "prompt_sent", ts: "2026-06-06T00:00:10.000Z", payload: { text: "duplicate tail" } },
			],
			minSeq: 10,
			maxSeq: 10,
			hasMore: false,
			cursorSatisfied: false,
			resetRequired: true,
		});

		expect(helpers.terminalBody.textContent).toContain("already visible");
		expect(helpers.terminalBody.textContent).toContain("Feed history gap: older events are unavailable, keeping visible history and appending latest events.");
		expect(helpers.terminalBody.textContent).toContain("tail after gap");
		expect(helpers.terminalBody.textContent).not.toContain("duplicate tail");
		expect(helpers.terminalBody.querySelectorAll(".worker-feed-history-gap-warning").length).toBe(1);
		expect(helpers.getV2State().v2LastSeq).toBe(10);
	});

	it("builds historical worker feed endpoints with batchId", () => {
		const helpers = loadWorkerFeedRuntime();

		expect(helpers.buildAgentEventsEndpoint({ agentId: "agent-1" })).toBe(
			"/api/agent-events/agent-1",
		);
		expect(helpers.buildAgentEventsEndpoint({ agentId: "agent 1", batchId: "batch/old" })).toBe(
			"/api/agent-events/agent%201?batchId=batch%2Fold",
		);
	});

	it("includes historical worker feed UI when history task agent metadata is present", () => {
		const src = readFileSync(APP_JS, "utf8");

		expect(src).toContain("function historyTaskAgentId");
		expect(src).toContain("openHistoricalWorkerFeed");
		expect(src).toContain("history-worker-feed-btn");
		expect(src).not.toContain("onclick=");
	});

	it("renders agents as an operational table without card markup", () => {
		const runtime = loadAgentsPanelRuntime();
		runtime.renderAgentsPanel({
			agents: {
				"worker-2": {
					agentId: "worker-2",
					role: "worker",
					laneNumber: 2,
					taskId: "TASK-002",
					status: "running",
					startedAt: Date.now() - 65_000,
				},
			},
		});

		expect(runtime.panel.style.display).toBe("");
		expect(runtime.body.textContent).toContain('<table class="agents-table">');
		expect(runtime.body.textContent).toContain(
			"<th>Agent</th><th>Role</th><th>Lane</th><th>Task</th><th>Status</th><th>Runtime</th>",
		);
		expect(runtime.body.textContent).not.toContain("agent-card");
		expect(runtime.body.textContent).not.toContain("status-dot");
	});

	it("escapes agent table values", () => {
		const runtime = loadAgentsPanelRuntime();
		runtime.renderAgentsPanel({
			agents: {
				bad: {
					agentId: 'agent<script>alert("x")</script>`',
					role: "worker",
					laneNumber: 1,
					taskId: "TASK<&>",
					status: "running",
				},
			},
		});

		expect(runtime.body.textContent).toContain(
			"agent&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#96;",
		);
		expect(runtime.body.textContent).toContain("TASK&lt;&amp;&gt;");
		expect(runtime.body.textContent).not.toContain('<script>alert("x")</script>');
	});

	it("maps agent statuses to compact badge labels and muted shutdown state", () => {
		const runtime = loadAgentsPanelRuntime();
		runtime.renderAgentsPanel({
			agents: {
				running: { agentId: "running", role: "worker", status: "running" },
				wrapping: { agentId: "wrapping", role: "worker", status: "wrapping_up" },
				spawning: { agentId: "spawning", role: "worker", status: "spawning" },
				exited: { agentId: "exited", role: "worker", status: "exited" },
				killed: { agentId: "killed", role: "worker", status: "killed" },
				crashed: { agentId: "crashed", role: "worker", status: "crashed" },
				timed: { agentId: "timed", role: "worker", status: "timed_out" },
			},
		});

		expect(runtime.body.textContent).toContain(
			'<span class="status-badge status-running">running</span>',
		);
		expect(runtime.body.textContent).toContain(
			'<span class="status-badge status-running">wrapping_up</span>',
		);
		expect(runtime.body.textContent).toContain(
			'<span class="status-badge status-stalled">spawning</span>',
		);
		expect(runtime.body.textContent).toContain(
			'<span class="status-badge status-failed">crashed</span>',
		);
		expect(runtime.body.textContent).toContain(
			'<span class="status-badge status-failed">timed out</span>',
		);
		expect(runtime.body.textContent).toContain(
			'<span class="status-badge status-skipped agent-status-shutdown">shutdown</span>',
		);
		expect(runtime.body.textContent).toContain('<tr class="agent-terminal-row">');
	});

	it("sorts live workers by lane before mergers and terminal agents", () => {
		const runtime = loadAgentsPanelRuntime();
		runtime.renderAgentsPanel({
			agents: {
				"merger-live": { agentId: "merger-live", role: "merger", laneNumber: 1, status: "running" },
				"worker-2": { agentId: "worker-2", role: "worker", laneNumber: 2, status: "running" },
				"worker-1": { agentId: "worker-1", role: "worker", laneNumber: 1, status: "running" },
				"worker-exited": { agentId: "worker-exited", role: "worker", laneNumber: 0, status: "exited" },
			},
		});
		const html = runtime.body.textContent;

		expect(html.indexOf("worker-1")).toBeLessThan(html.indexOf("worker-2"));
		expect(html.indexOf("worker-2")).toBeLessThan(html.indexOf("merger-live"));
		expect(html.indexOf("merger-live")).toBeLessThan(html.indexOf("worker-exited"));
	});

	it("keeps the agents panel hidden for an empty registry", () => {
		const runtime = loadAgentsPanelRuntime();
		runtime.renderAgentsPanel({ agents: {} });

		expect(runtime.panel.style.display).toBe("none");
	});
});
