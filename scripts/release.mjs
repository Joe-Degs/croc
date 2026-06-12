#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const releaseTarget = process.argv[2];
const bumpTypes = new Set(["major", "minor", "patch"]);
const semverPattern = /^\d+\.\d+\.\d+$/;

function printUsage() {
	console.log(`Usage: node scripts/release.mjs <major|minor|patch|x.y.z>

Prepares a Croc release locally:
  1. Requires a clean main branch
  2. Bumps package.json and package-lock.json
  3. Rolls CHANGELOG.md [Unreleased] into the target version
  4. Runs tests, checks, build, package validation, and release asset build
  5. Commits and tags vX.Y.Z
  6. Adds a fresh [Unreleased] changelog section
  7. Prints push commands without pushing
`);
}

if (!releaseTarget || (!bumpTypes.has(releaseTarget) && !semverPattern.test(releaseTarget))) {
	printUsage();
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson() {
	return JSON.parse(readFileSync("package.json", "utf8"));
}

function readChangelog() {
	return readFileSync("CHANGELOG.md", "utf8");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let index = 0; index < 3; index++) {
		const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
		if (diff !== 0) return diff;
	}

	return 0;
}

function bumpVersion(version, bumpType) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (bumpType === "major") return `${major + 1}.0.0`;
	if (bumpType === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function getTargetVersion(currentVersion, target) {
	if (bumpTypes.has(target)) return bumpVersion(currentVersion, target);
	if (compareVersions(target, currentVersion) <= 0) {
		throw new Error(`Release version ${target} must be greater than current version ${currentVersion}.`);
	}
	return target;
}

function assertCleanTree() {
	const status = run("git", ["status", "--porcelain"], { capture: true });
	if (status.trim()) throw new Error(`Uncommitted changes detected. Commit or stash first.\n${status.trim()}`);
}

function assertMainBranch() {
	const branch = run("git", ["branch", "--show-current"], { capture: true }).trim();
	if (branch !== "main") throw new Error(`Releases must be prepared from main, current branch is ${branch || "detached HEAD"}.`);
}

function assertTagAvailable(tag) {
	const result = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
		encoding: "utf8",
		stdio: "ignore",
	});
	if (result.status === 0) throw new Error(`Tag ${tag} already exists.`);
}

function updateChangelogForRelease(version) {
	const date = new Date().toISOString().slice(0, 10);
	const changelog = readChangelog();
	if (!changelog.includes("## [Unreleased]")) throw new Error("CHANGELOG.md must contain a ## [Unreleased] section.");
	const updated = changelog.replace("## [Unreleased]", `## [${version}] - ${date}`);
	writeFileSync("CHANGELOG.md", updated);
}

function addNextUnreleasedSection() {
	const changelog = readChangelog();
	if (changelog.includes("## [Unreleased]")) throw new Error("CHANGELOG.md already contains a ## [Unreleased] section.");
	const firstVersionHeading = changelog.search(/^## \[/m);
	if (firstVersionHeading === -1) throw new Error("Could not find a version heading in CHANGELOG.md.");
	const updated = `${changelog.slice(0, firstVersionHeading)}## [Unreleased]\n\n${changelog.slice(firstVersionHeading)}`;
	writeFileSync("CHANGELOG.md", updated);
}

function assertOnlyReleaseFilesChanged() {
	const status = run("git", ["status", "--porcelain"], { capture: true });
	const changed = status
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const allowed = new Set(["CHANGELOG.md", "package.json", "package-lock.json"]);
	const unexpected = changed.filter((line) => !allowed.has(line.slice(3)));
	if (unexpected.length > 0) {
		throw new Error(`Release checks changed unexpected files:\n${unexpected.join("\n")}`);
	}
}

const currentVersion = readPackageJson().version;
const nextVersion = getTargetVersion(currentVersion, releaseTarget);
const tag = `v${nextVersion}`;

console.log(`\nPreparing Croc ${tag}\n`);

assertCleanTree();
assertMainBranch();
assertTagAvailable(tag);

run("npm", ["version", nextVersion, "--no-git-tag-version", "--ignore-scripts"]);
updateChangelogForRelease(nextVersion);

run("npm", ["test"]);
run("npm", ["run", "check"]);
run("npm", ["run", "build"]);
run("npm", ["run", "pack:check"]);
run("npm", ["run", "release:assets"]);

assertOnlyReleaseFilesChanged();

run("git", ["add", "CHANGELOG.md", "package.json", "package-lock.json"]);
run("git", ["commit", "-m", `release v${nextVersion}`]);
run("git", ["tag", tag]);

addNextUnreleasedSection();
run("git", ["add", "CHANGELOG.md"]);
run("git", ["commit", "-m", "start next changelog cycle"]);

console.log(`\nPrepared ${tag}. Review the release assets in release-assets/.`);
console.log("Push when ready:");
console.log("  git push origin main");
console.log(`  git push origin ${tag}`);
