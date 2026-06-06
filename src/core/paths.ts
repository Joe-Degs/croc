import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

export function getPackageRoot(): string {
	return resolve(__dirname, "..", "..");
}

export function getCrocProviderExtensionPath(): string {
	const root = getPackageRoot();
	const builtExtension = join(root, "dist", "extensions", "provider.js");
	if (existsSync(builtExtension)) {
		return builtExtension;
	}
	return join(root, "src", "extensions", "provider.ts");
}

export function getBundledTaskplanePackagePath(): string {
	const sourceTaskplanePath = join(getPackageRoot(), "packages", "taskplane");
	if (existsSync(join(sourceTaskplanePath, "package.json"))) {
		return sourceTaskplanePath;
	}
	return dirname(require.resolve("taskplane/package.json"));
}

export function getBundledTaskplaneBinPath(): string {
	return join(getBundledTaskplanePackagePath(), "bin", "taskplane.mjs");
}
