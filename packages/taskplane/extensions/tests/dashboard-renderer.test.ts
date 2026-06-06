import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "./expect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = resolve(__dirname, "../../dashboard/public/app.js");

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
	parentNode: FakeElement | null = null;
	private ownText = "";
	tagName: string;

	constructor(tagName: string) {
		this.tagName = tagName;
	}

	appendChild<T extends FakeElement | FakeText>(child: T): T {
		child.parentNode = this;
		this.children.push(child);
		return child;
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
					return `<${child.tagName}${classAttr}>${child.innerHTML}</${child.tagName}>`;
				})
				.join("")
		);
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
	renderConvEvent: (event: Record<string, unknown>) => string | FakeElement;
	renderV2Event: (event: Record<string, unknown>) => string | FakeElement;
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
		`${helperSrc}\nreturn { stripUnsupportedAnsiControls, createOutputBlock, createTruncationBadge };`,
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
		src.slice(helperStart, helperEnd),
		src.slice(v2Start, v2End),
		src.slice(convStart, convEnd),
	].join("\n");
	return new Function(
		"document",
		"TextEncoder",
		`${rendererSrc}\nreturn { stripUnsupportedAnsiControls, createOutputBlock, createTruncationBadge, renderConvEvent, renderV2Event };`,
	)(fakeDocument, TextEncoder) as RendererHelpers;
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

	it("renders Runtime V2 tool_result output-like summary through the output primitive", () => {
		const helpers = loadRenderers();
		const rendered = helpers.renderV2Event({
			type: "tool_result",
			ts: "2026-06-06T00:00:00.000Z",
			payload: {
				summary: '<svg onload=alert(1)></svg><script>alert("x")</script> & done',
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
	});
});
