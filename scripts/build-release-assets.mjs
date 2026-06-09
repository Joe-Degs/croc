#!/usr/bin/env node

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const outputDir = "release-assets";

function packPackage() {
	const output = execSync(`npm pack --ignore-scripts --json --pack-destination ${JSON.stringify(outputDir)}`, {
		encoding: "utf8",
	});
	const manifests = JSON.parse(output);
	const manifest = manifests[0];
	if (!manifest?.filename) throw new Error("npm pack did not return a tarball filename.");
	return manifest.filename;
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const tarball = packPackage();
const source = join(outputDir, tarball);

for (const platform of platforms) {
	copyFileSync(source, join(outputDir, `croc-${platform}.tar.gz`));
}

rmSync(source);

console.log(
	JSON.stringify(
		{
			outputDir,
			assets: platforms.map((platform) => `croc-${platform}.tar.gz`),
		},
		null,
		2,
	),
);
