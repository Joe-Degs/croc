import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "./expect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = resolve(__dirname, "../../dashboard/public/app.js");
const STYLE_CSS = resolve(__dirname, "../../dashboard/public/style.css");

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

class FakeElement {
	nodeType = 1;
	className = "";
	classList = new FakeClassList(this);
	children: Array<FakeElement | FakeText> = [];
	dataset: Record<string, string> = {};
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
		this.attributes[name] = String(value);
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	addEventListener(name: string, listener: () => void): void {
		this.listeners[name] = [...(this.listeners[name] || []), listener];
	}

	click(): void {
		for (const listener of this.listeners.click || []) listener();
	}

	insertBefore<T extends FakeElement | FakeText>(
		child: T,
		before: FakeElement | FakeText | null,
	): T {
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
		return (
			own +
			this.children
				.map((child) => {
					if (child instanceof FakeText) return child.innerHTML;
					const classAttr = child.className ? ` class="${escapeText(child.className)}"` : "";
					const idAttr = child.id ? ` id="${escapeText(child.id)}"` : "";
					return `<${child.tagName}${idAttr}${classAttr}>${child.innerHTML}</${child.tagName}>`;
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
	renderV2AgentEvents: (events: Array<Record<string, unknown>>) => void;
	resetV2FeedState: () => void;
	buildAgentEventsEndpoint: (context: Record<string, unknown>) => string;
	getV2State: () => { v2LastCursor: string | null; v2FirstRender: boolean; groupCount: number };
	setV2Cursor: (cursor: string) => void;
	terminalBody: FakeElement;
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
	const helperStart = src.indexOf("function escapeHtml");
	const helperEnd = src.indexOf("/** Format token count", helperStart);
	const v2Start = src.indexOf("function buildAgentEventsEndpoint");
	const v2End = src.indexOf("// ── Segment-Scoped STATUS.md Helpers", v2Start);
	if (helperStart < 0 || helperEnd < 0 || v2Start < 0 || v2End < 0) {
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
			src.slice(helperStart, helperEnd),
			src.slice(v2Start, v2End),
			"function getV2State() { return { v2LastCursor, v2FirstRender, groupCount: v2ToolGroups.size }; }",
			"function setV2Cursor(cursor) { v2LastCursor = cursor; }",
			"return { stripUnsupportedAnsiControls, createOutputBlock, createTruncationBadge, appendOutputText, replaceOutputText, renderConvEvent: null, renderV2Event, renderV2AgentEvents, resetV2FeedState, buildAgentEventsEndpoint, getV2State, setV2Cursor, terminalBody: $terminalBody };",
		].join("\n"),
	)(fakeDocument, TextEncoder, terminalBody, (fn: () => void) => fn()) as RendererHelpers;
}

describe("dashboard safe output renderer", () => {
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

	it("renders direct ls file tools as dollar-prefixed command runs", () => {
		const helpers = loadRenderers();
		const path =
			"/Users/hubteluser/hubtel/maelstrom-croc-test/.croc/workspace/repos/app/.worktrees/hubteluser-20260606T225737/lane-2";
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
			'rm -rf /Users/hubteluser/hubtel/movie-night-croc-test/.croc/workspace/packets/taskplane-tasks/TASK-007-add-end-to-end-smoke-tests-and-self-repair-broken-app-flows/ && cd /Users/hubteluser/hubtel/movie-night-croc-test/.croc/workspace/packets && git add -A && git commit -m "chore: remove empty TASK-007 folder that was causing discovery crash"';
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
			"/Users/hubteluser/hubtel/maelstrom-croc-test/.croc/workspace/repos/app/.worktrees/hubteluser-20260606T225737/lane-2";

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
		expect(rendered.classList.contains("worker-feed-file-tool")).toBe(true);
		expect(rendered.classList.contains("worker-feed-read-tool")).toBe(true);
		expect(rendered.textContent).not.toContain("call-1");
	});

	it("does not render lifecycle labels without lifecycle details", () => {
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
		expect(helpers.terminalBody.textContent).not.toContain("agent started");
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
		expect(rendered.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(rendered.textContent).toContain("... (2 more lines, click to expand)");
		expect(rendered.textContent).not.toContain("-7\n-8");
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

		expect(helpers.getV2State()).toEqual({ v2LastCursor: null, v2FirstRender: true, groupCount: 0 });
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
	});
});
