#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const expectedPackageName = "croc";
const requiredFiles = [
	"CHANGELOG.md",
	"dist/cli.js",
	"docs/release.md",
	"examples/model-provider/croc.yaml",
	"examples/rate-limiter-task-with-headroom/croc.yaml",
];
const forbiddenTextPattern = /hubtel|grm-2\.6|llm\.hubtel|HUBTEL_LLM_API_KEY/i;
const searxngUrlPattern = /https?:\/\/[^\s<>]*searxng(?!\.example\.invalid)/i;

function readPackManifest() {
	const output = execSync("npm pack --dry-run --ignore-scripts --json", { encoding: "utf8" });
	const manifests = JSON.parse(output);
	const manifest = manifests[0];
	if (!manifest) throw new Error("npm pack did not return a package manifest.");
	return manifest;
}

function readTextFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

const manifest = readPackManifest();
const paths = manifest.files.map((file) => file.path);
const failures = [];

if (manifest.name !== expectedPackageName) {
	failures.push(`expected package name ${expectedPackageName}, got ${manifest.name}`);
}

for (const file of requiredFiles) {
	if (!paths.includes(file)) failures.push(`missing required package file ${file}`);
}

try {
	const cliVersion = execFileSync(process.execPath, ["dist/cli.js", "version"], { encoding: "utf8" }).trim();
	if (cliVersion !== manifest.version) failures.push(`dist/cli.js reports version ${cliVersion}, expected ${manifest.version}`);
} catch (error) {
	failures.push(`failed to run dist/cli.js version: ${error.message}`);
}

const runNoteFiles = paths.filter((path) => path.startsWith("docs/runs/"));
if (runNoteFiles.length > 0) failures.push(`package includes docs/runs files: ${runNoteFiles.join(", ")}`);

const forbiddenFiles = [];
const suspiciousSearxngUrlFiles = [];
for (const path of paths) {
	if (!existsSync(path)) continue;
	const text = readTextFile(path);
	if (forbiddenTextPattern.test(text)) forbiddenFiles.push(path);
	if (searxngUrlPattern.test(text)) suspiciousSearxngUrlFiles.push(path);
}

if (forbiddenFiles.length > 0) failures.push(`package includes forbidden personal defaults in: ${forbiddenFiles.join(", ")}`);
if (suspiciousSearxngUrlFiles.length > 0) {
	failures.push(`package includes non-placeholder SearXNG URLs in: ${suspiciousSearxngUrlFiles.join(", ")}`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`Package validation failed: ${failure}`);
	process.exit(1);
}

console.log(
	JSON.stringify(
		{
			name: manifest.name,
			version: manifest.version,
			filename: manifest.filename,
			entryCount: manifest.entryCount,
			requiredFilesPresent: requiredFiles,
		},
		null,
		2,
	),
);
